const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_CHANNEL_ID = String(process.env.DB_CHANNEL_ID || '-1004365559436').trim();
const ADMIN_ID = String(process.env.ADMIN_ID || '5411921025').trim();
const BOT_USERNAME = process.env.BOT_USERNAME || 'LankaFile_bot';

let cachedClient = null;
let cachedDb = null;

async function getDb() {
  if (cachedDb) return cachedDb;
  if (!cachedClient) {
    cachedClient = new MongoClient(MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000
    });
    await cachedClient.connect();
  }
  cachedDb = cachedClient.db('file_store_bot');
  return cachedDb;
}

async function getSettings(db) {
  try {
    const col = db.collection('settings');
    let s = await col.findOne({ _id: 'config' });
    if (!s) {
      s = {
        _id: 'config',
        fsub_enabled: true,
        fsub_channels: [],
        protect_content: true,
        auto_delete: true,
        delete_delay_minutes: 180,
        welcome_text: "👋 Welcome {mention}! Click a valid link to get your files.",
        warning_text: "⚠️ Important: All messages will be deleted after {time}\n\n<blockquote>👑 HOT LANKA VIP ACCESS 💰 Fee: Rs. 500/= only 📩 Get VIP: @LankaAdmin_bot</blockquote>"
      };
      await col.insertOne(s);
    }
    return s;
  } catch (err) {
    console.error('getSettings error:', err.message);
    return {
      fsub_enabled: false,
      fsub_channels: [],
      protect_content: true,
      auto_delete: true,
      delete_delay_minutes: 180,
      welcome_text: "👋 Welcome! Click a valid link to get your files.",
      warning_text: "⚠️ Important: All messages will be deleted after {time}"
    };
  }
}

// Background User Tracking (කිසිම වෙලාවක bot block වෙන්නේ නැත)
function trackUserBackground(db, user) {
  if (!user || !user.id) return;
  db.collection('bot_users').updateOne(
    { user_id: user.id },
    {
      $set: { first_name: user.first_name \vert{}\vert{} '', username: user.username \vert{}\vert{} '', last_active: new Date() },$setOnInsert: { joined_at: new Date() }
    },
    { upsert: true }
  ).catch(err => console.error('trackUser error:', err.message));
}

const bot = new Telegraf(BOT_TOKEN);
const adminStates = {};

// Helper: Format Placeholders
function formatUserText(text, user) {
  if (!text) return '';
  const firstName = user.first_name || '';
  const lastName = user.last_name || '';
  const fullName = `${firstName} ${lastName}`.trim() || 'User';
  const mention = `<a href="tg://user?id=${user.id}">${fullName}</a>`;

  return text
    .replace(/{mention}/g, mention)
    .replace(/{first_name}/g, firstName)
    .replace(/{last_name}/g, lastName);
}

// Helper: Check FSUB
async function checkFsub(ctx, userId, channels) {
  const notJoined = [];
  for (const ch of channels) {
    try {
      const channelId = String(ch.id).trim();
      const member = await ctx.telegram.getChatMember(channelId, userId);
      if (['left', 'kicked'].includes(member.status)) {
        notJoined.push(ch);
      }
    } catch (e) {
      notJoined.push(ch);
    }
  }
  return notJoined;
}

function formatDuration(mins) {
  if (mins < 60) return `${mins} minutes`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} hour${hrs > 1 ? 's' : ''}`;
}

function safeBase64Decode(str) {
  let cleaned = str.replace(/-/g, '+').replace(/_/g, '/');
  while (cleaned.length % 4 !== 0) {
    cleaned += '=';
  }
  return Buffer.from(cleaned, 'base64');
}

function decodeOldCodeX(buf) {
  for (let i = 8; i <= buf.length - 4; i++) {
    if (buf[i] === 0x00 && buf[i + 1] === 0x00) {
      const candidateId = buf.readUInt16BE(i + 2);
      if (candidateId > 0 && candidateId < 1000000) {
        return candidateId;
      }
    }
  }
  if (buf.length >= 14) {
    const val1 = buf.readUInt16BE(12);
    if (val1 > 0) return val1;
  }
  return null;
}

// /start Handler
bot.start(async (ctx) => {
  try {
    const db = await getDb();
    trackUserBackground(db, ctx.from);
    const settings = await getSettings(db);
    const payload = ctx.startPayload;
    const userId = ctx.from.id;

    if (payload) {
      // 1. Force Sub Check
      if (settings.fsub_enabled && settings.fsub_channels && settings.fsub_channels.length > 0) {
        const pendingChannels = await checkFsub(ctx, userId, settings.fsub_channels);
        if (pendingChannels.length > 0) {
          const buttons = pendingChannels.map(ch => [Markup.button.url(`📢 Join ${ch.title || 'Channel'}`, ch.link)]);
          buttons.push([Markup.button.url('🔄 Try Again', `https://t.me/${BOT_USERNAME}?start=${payload}`)]);
          return ctx.reply('⚠️ Please join our channel first to get your files:', Markup.inlineKeyboard(buttons));
        }
      }

      let msgIdsToSend = [];

      // Old Link Logic
      if (payload.startsWith('DW5')) {
        try {
          const rawBuf = safeBase64Decode(payload);
          const decodedOldId = decodeOldCodeX(rawBuf);
          if (decodedOldId && decodedOldId > 0) {
            msgIdsToSend.push(decodedOldId);
          }
        } catch (err) {
          console.error('Old link decode error:', err);
        }
      } 
      // Batch Logic
      else if (payload.startsWith('BATCH_')) {
        try {
          const b64Part = payload.replace('BATCH_', '');
          const rangeStr = safeBase64Decode(b64Part).toString('utf-8');
          const [startId, endId] = rangeStr.split('-').map(Number);
          if (startId && endId && startId <= endId) {
            for (let i = startId; i <= endId; i++) msgIdsToSend.push(i);
          }
        } catch (err) {
          console.error('Batch decode error:', err);
        }
      } 
      // New Single File Logic
      else {
        try {
          const singleId = Number(safeBase64Decode(payload).toString('utf-8'));
          if (!isNaN(singleId) && singleId > 0) {
            msgIdsToSend.push(singleId);
          }
        } catch (err) {
          console.error('Single link decode error:', err);
        }
      }

      if (msgIdsToSend.length === 0) {
        return ctx.reply('❌ Invalid or expired link.');
      }

      // Copy messages
      const sentMsgIds = [];
      for (const msgId of msgIdsToSend) {
        try {
          const res = await ctx.telegram.copyMessage(ctx.chat.id, DB_CHANNEL_ID, msgId, {
            protect_content: settings.protect_content
          });
          sentMsgIds.push(res.message_id);
        } catch (err) {
          console.warn(`Skipped missing/deleted msg ${msgId}: ${err.message}`);
        }
      }

      if (sentMsgIds.length > 0) {
        let warnText = settings.warning_text.replace('{time}', formatDuration(settings.delete_delay_minutes));
        warnText = formatUserText(warnText, ctx.from);
        const warnMsg = await ctx.reply(warnText, { parse_mode: 'HTML' });
        sentMsgIds.push(warnMsg.message_id);

        if (settings.auto_delete) {
          const deleteAt = new Date(Date.now() + settings.delete_delay_minutes * 60 * 1000);
          await db.collection('deletion_queue').insertOne({
            chat_id: ctx.chat.id,
            message_ids: sentMsgIds,
            delete_at: deleteAt
          }).catch(err => console.error('deletion_queue error:', err.message));
        }
      } else {
        return ctx.reply('❌ No available files found for this link.');
      }

      return;
    }

    const formattedWelcome = formatUserText(settings.welcome_text, ctx.from);
    return ctx.reply(formattedWelcome, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Error in bot.start:', e);
    return ctx.reply('👋 Welcome to the Bot!');
  }
});

// Bot Analytics / Stats Command
bot.command('stats', async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) return;
  try {
    const db = await getDb();
    const settings = await getSettings(db);

    const totalUsers = await db.collection('bot_users').countDocuments();
    const pendingDeletes = await db.collection('deletion_queue').countDocuments();

    const statsText = `📊 <b>Bot Analytics & Stats</b>\n\n` +
      `👥 <b>Total Active Users:</b> <code>${totalUsers}</code>\n` +
      `🗑 <b>Pending Auto-Deletes:</b> <code>${pendingDeletes}</code>\n` +
      `📢 <b>FSUB Channels Active:</b> <code>${settings.fsub_channels.length}</code>\n` +
      `⏱ <b>Auto-Delete Delay:</b> <code>${formatDuration(settings.delete_delay_minutes)}</code>\n` +
      `🛡 <b>Content Protection:</b> <code>${settings.protect_content ? 'Enabled' : 'Disabled'}</code>`;

    return ctx.reply(statsText, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('Stats error:', err);
    return ctx.reply(`❌ Stats Error: ${err.message}`);
  }
});

// Broadcast Command Setup
bot.command('broadcast', async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) return;
  adminStates[ctx.from.id] = 'awaiting_broadcast_message';
  return ctx.reply('📢 <b>Broadcast Setup:</b>\n\nPlease send the message (Text, Photo, Video) you want to broadcast to all users.', { parse_mode: 'HTML' });
});

// Admin Panel Command
bot.command('settings', async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) return;
  try {
    const db = await getDb();
    const settings = await getSettings(db);

    const panelText = `⚙️ **Bot Control Panel**\n\n` +
      `• Force Sub: ${settings.fsub_enabled ? '🟢 ON' : '🔴 OFF'}\n` +
      `• Content Protect: ${settings.protect_content ? '🟢 ON' : '🔴 OFF'}\n` +
      `• Auto-Delete: ${settings.auto_delete ? '🟢 ON' : '🔴 OFF'}\n` +
      `• Delete Delay: ⏱️ ${formatDuration(settings.delete_delay_minutes)}\n` +
      `• FSUB Channels: ${settings.fsub_channels.length}`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(`FSUB: ${settings.fsub_enabled ? '🟢 ON' : '🔴 OFF'}`, 'toggle_fsub'),
        Markup.button.callback(`Protect: ${settings.protect_content ? '🟢 ON' : '🔴 OFF'}`, 'toggle_protect')
      ],
      [
        Markup.button.callback(`Auto-Delete: ${settings.auto_delete ? '🟢 ON' : '🔴 OFF'}`, 'toggle_autodel')
      ],
      [
        Markup.button.callback('⏱️ 5 Mins', 'set_time_5'),
        Markup.button.callback('⏱️ 15 Mins', 'set_time_15'),
        Markup.button.callback('⏱️ 1 Hour', 'set_time_60')
      ],
      [
        Markup.button.callback('⏱️ 3 Hours', 'set_time_180'),
        Markup.button.callback('⏱️ 6 Hours', 'set_time_360'),
        Markup.button.callback('⏱️ 24 Hours', 'set_time_1440')
      ],
      [
        Markup.button.callback('📢 Manage FSUB Channels', 'manage_fsub')
      ],
      [
        Markup.button.callback('✏️ Edit /start Text', 'edit_welcome'),
        Markup.button.callback('✏️ Edit Warning Text', 'edit_warning')
      ]
    ]);

    return ctx.reply(panelText, { parse_mode: 'Markdown', ...keyboard });
  } catch (e) {
    console.error('Settings command error:', e);
  }
});

bot.action(/^(toggle_fsub|toggle_protect|toggle_autodel|set_time_\d+)$/, async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  const action = ctx.match[1];
  const db = await getDb();
  const col = db.collection('settings');
  const settings = await getSettings(db);

  if (action === 'toggle_fsub') {
    await col.updateOne({ _id: 'config' }, { $set: { fsub_enabled: !settings.fsub_enabled } });
  } else if (action === 'toggle_protect') {
    await col.updateOne({ _id: 'config' }, { $set: { protect_content: !settings.protect_content } });
  } else if (action === 'toggle_autodel') {
    await col.updateOne({ _id: 'config' }, { $set: { auto_delete: !settings.auto_delete } });
  } else if (action.startsWith('set_time_')) {
    const mins = parseInt(action.replace('set_time_', ''));
    await col.updateOne({ _id: 'config' }, { $set: { delete_delay_minutes: mins } });
  }

  await ctx.answerCbQuery('Settings Updated!');
  const updated = await getSettings(db);
  const panelText = `⚙️ **Bot Control Panel**\n\n` +
    `• Force Sub: ${updated.fsub_enabled ? '🟢 ON' : '🔴 OFF'}\n` +
    `• Content Protect: ${updated.protect_content ? '🟢 ON' : '🔴 OFF'}\n` +
    `• Auto-Delete: ${updated.auto_delete ? '🟢 ON' : '🔴 OFF'}\n` +
    `• Delete Delay: ⏱️ ${formatDuration(updated.delete_delay_minutes)}\n` +
    `• FSUB Channels: ${updated.fsub_channels.length}`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(`FSUB: ${updated.fsub_enabled ? '🟢 ON' : '🔴 OFF'}`, 'toggle_fsub'),
      Markup.button.callback(`Protect: ${updated.protect_content ? '🟢 ON' : '🔴 OFF'}`, 'toggle_protect')
    ],
    [
      Markup.button.callback(`Auto-Delete: ${updated.auto_delete ? '🟢 ON' : '🔴 OFF'}`, 'toggle_autodel')
    ],
    [
      Markup.button.callback('⏱️ 5 Mins', 'set_time_5'),
      Markup.button.callback('⏱️ 15 Mins', 'set_time_15'),
      Markup.button.callback('⏱️ 1 Hour', 'set_time_60')
    ],
    [
      Markup.button.callback('⏱️ 3 Hours', 'set_time_180'),
      Markup.button.callback('⏱️ 6 Hours', 'set_time_360'),
      Markup.button.callback('⏱️ 24 Hours', 'set_time_1440')
    ],
    [
      Markup.button.callback('📢 Manage FSUB Channels', 'manage_fsub')
    ],
    [
      Markup.button.callback('✏️ Edit /start Text', 'edit_welcome'),
      Markup.button.callback('✏️ Edit Warning Text', 'edit_warning')
    ]
  ]);
  return ctx.editMessageText(panelText, { parse_mode: 'Markdown', ...keyboard });
});

bot.action('manage_fsub', async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  const db = await getDb();
  const settings = await getSettings(db);

  let listText = "📢 **FSUB Channels List:**\n\n";
  const buttons = [];

  if (settings.fsub_channels.length === 0) {
    listText += "No channels added yet.\n";
  } else {
    settings.fsub_channels.forEach((ch, idx) => {
      listText += `${idx + 1}. [${ch.title}](${ch.link}) (ID: \`${ch.id}\`)\n`;
      buttons.push([Markup.button.callback(`🗑 Remove ${ch.title}`, `del_fsub_${ch.id}`)]);
    });
  }

  buttons.push([Markup.button.callback('➕ Add New Channel', 'add_fsub')]);
  buttons.push([Markup.button.callback('⬅️ Back to Settings', 'back_settings')]);

  await ctx.answerCbQuery();
  return ctx.editMessageText(listText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action('add_fsub', async (ctx) => {
  adminStates[ctx.from.id] = 'awaiting_fsub_input';
  await ctx.answerCbQuery();
  return ctx.reply("Please send channel details in this format:\n\n`<Channel_ID>|<Channel_Title>|<Channel_Link>`\n\nExample:\n`-1004306300202|Backup Channel|https://t.me/yourbackup`");
});

bot.action(/^del_fsub_(.+)$/, async (ctx) => {
  const chId = ctx.match[1];
  const db = await getDb();
  await db.collection('settings').updateOne({ _id: 'config' }, { $pull: { fsub_channels: { id: chId } } });
  await ctx.answerCbQuery('Channel Removed!');
  return ctx.reply('Channel removed successfully. Send /settings to refresh.');
});

bot.action('edit_welcome', async (ctx) => {
  adminStates[ctx.from.id] = 'awaiting_welcome_text';
  await ctx.answerCbQuery();
  return ctx.reply("Please send your new /start Welcome Message.\n\nYou can use placeholders:\n• {mention}\n• {first_name}\n• {last_name}");
});

bot.action('edit_warning', async (ctx) => {
  adminStates[ctx.from.id] = 'awaiting_warning_text';
  await ctx.answerCbQuery();
  return ctx.reply("Please send your Warning Message.\n\nPlaceholders available: {time}, {mention}");
});

bot.action('back_settings', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.deleteMessage();
});

bot.command('batch', async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) return;
  adminStates[ctx.from.id] = 'awaiting_batch_start';
  return ctx.reply('📦 Batch Creation:\nPlease send the Message Link (or Message ID) of the first file in your channel:');
});

bot.on(['message'], async (ctx) => {
  const userId = ctx.from.id;
  const state = adminStates[userId];

  if (String(userId) === ADMIN_ID && state) {
    const db = await getDb();

    // Broadcast Execution
    if (state === 'awaiting_broadcast_message') {
      delete adminStates[userId];
      const users = await db.collection('bot_users').find({}).toArray();
      const statusMsg = await ctx.reply(`🚀 Broadcasting started to ${users.length} users...`);

      let successful = 0;
      let failed = 0;

      for (const u of users) {
        try {
          await ctx.telegram.copyMessage(u.user_id, ctx.chat.id, ctx.message.message_id);
          successful++;
        } catch (err) {
          failed++;
        }
      }

      return ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        `✅ <b>Broadcast Completed!</b>\n\n` +
        `👥 <b>Total Users:</b> <code>${users.length}</code>\n` +
        `🟢 <b>Successfully Sent:</b> <code>${successful}</code>\n` +
        `🔴 <b>Failed/Blocked:</b> <code>${failed}</code>`,
        { parse_mode: 'HTML' }
      );
    }

    if (state === 'awaiting_fsub_input') {
      const parts = ctx.message.text ? ctx.message.text.split('|') : [];
      if (parts.length === 3) {
        await db.collection('settings').updateOne(
          { _id: 'config' },
          { $push: { fsub_channels: { id: parts[0].trim(), title: parts[1].trim(), link: parts[2].trim() } } }
        );
        delete adminStates[userId];
        return ctx.reply('✅ FSUB Channel added successfully!');
      } else {
        return ctx.reply('❌ Invalid format. Please try again.');
      }
    } else if (state === 'awaiting_welcome_text') {
      await db.collection('settings').updateOne({ _id: 'config' }, { $set: { welcome_text: ctx.message.text } });
      delete adminStates[userId];
      return ctx.reply('✅ Welcome Message updated successfully!');
    } else if (state === 'awaiting_warning_text') {
      await db.collection('settings').updateOne({ _id: 'config' }, { $set: { warning_text: ctx.message.text } });
      delete adminStates[userId];
      return ctx.reply('✅ Warning Message updated successfully!');
    } else if (state === 'awaiting_batch_start') {
      const text = ctx.message.text || '';
      const match = text.match(/\/(\d+)$/) || [null, text];
      adminStates[userId] = { type: 'batch', startId: parseInt(match[1]) };
      return ctx.reply('Awesome! Now send the Message Link (or Message ID) of the last file:');
    } else if (typeof state === 'object' && state.type === 'batch') {
      const text = ctx.message.text || '';
      const match = text.match(/\/(\d+)$/) || [null, text];
      const endId = parseInt(match[1]);
      const startId = state.startId;
      delete adminStates[userId];

      if (startId && endId && startId <= endId) {
        const payload = Buffer.from(`${startId}-${endId}`).toString('base64');
        const link = `https://t.me/${BOT_USERNAME}?start=BATCH_${payload}`;
        return ctx.reply(`🔥 Hot Lanka Exclusive 🔥\n${link}`);
      } else {
        return ctx.reply('❌ Invalid Message IDs. Please run /batch to start again.');
      }
    }
  }

  if (String(userId) === ADMIN_ID) {
    const isMedia = ctx.message.document || ctx.message.video || ctx.message.photo || ctx.message.audio;
    if (isMedia) {
      try {
        const copied = await ctx.telegram.copyMessage(DB_CHANNEL_ID, ctx.chat.id, ctx.message.message_id);
        const encoded = Buffer.from(String(copied.message_id)).toString('base64');
        const fileLink = `https://t.me/${BOT_USERNAME}?start=${encoded}`;

        return ctx.reply(`🔥 Hot Lanka Exclusive 🔥\n${fileLink}`);
      } catch (e) {
        console.error('Error storing single file:', e);
        return ctx.reply(`❌ Could not save file to Database Channel: ${e.message}`);
      }
    }
  }
});

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      await bot.handleUpdate(req.body);
    } catch (err) {
      console.error('Webhook handleUpdate error:', err);
    }
    return res.status(200).send('OK');
  }
  return res.status(200).send('Bot is active!');
};
