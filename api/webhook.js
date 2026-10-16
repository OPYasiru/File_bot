const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_CHANNEL_ID = String(process.env.DB_CHANNEL_ID || '-1004365559436').trim();
const ADMIN_ID = String(process.env.ADMIN_ID || '5411921025').trim();
const BOT_USERNAME = process.env.BOT_USERNAME || 'LankaFile_bot';

let cachedClient = null;
async function getDb() {
  if (!cachedClient) {
    cachedClient = new MongoClient(MONGODB_URI);
    await cachedClient.connect();
  }
  return cachedClient.db('file_store_bot');
}

async function getSettings(db) {
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
}

const bot = new Telegraf(BOT_TOKEN);

// Helper: Format Placeholders
function formatUserText(text, user) {
  if (!text) return '';
  const firstName = (user && user.first_name) ? user.first_name : '';
  const lastName = (user && user.last_name) ? user.last_name : '';
  const fullName = `${firstName}${lastName}`.trim() || 'User';
  const userId = user ? user.id : '';
  const mention = userId ? `<a href="tg://user?id=${userId}">${fullName}</a>` : fullName;

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

// Helper: Panel Builder with Stats
async function buildPanel(db) {
  const settings = await getSettings(db);
  const totalUsers = await db.collection('users').countDocuments();
  const pendingDeletions = await db.collection('deletion_queue').countDocuments();

  const panelText = `⚙️ **Bot Control Panel**\n\n` +
    `👥 **Total Users:** \`${totalUsers}\`\n` +
    `⏳ **Pending Deletions:** \`${pendingDeletions}\`\n\n` +
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

  return { panelText, keyboard };
}

// /start Handler
bot.start(async (ctx) => {
  if (!ctx.from) return;

  const db = await getDb();
  const settings = await getSettings(db);
  const payload = ctx.startPayload;
  const userId = ctx.from.id;

  // Safe Track Unique Users in MongoDB
  try {
    const fName = ctx.from.first_name || '';
    const uName = ctx.from.username || null;
    await db.collection('users').updateOne(
      { _id: userId },
      { 
        $set: { 
          first_name: fName, 
          username: uName, 
          last_active: new Date() 
        },
        $setOnInsert: { joined_at: new Date() }
      },
      { upsert: true }
    );
  } catch (err) {
    console.error('Error tracking user:', err.message);
  }

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
        console.warn(`Skipped missing/deleted msg ${msgId}:${err.message}`);
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
        });
      }
    } else {
      return ctx.reply('❌ No available files found for this link.');
    }

    return;
  }

  const formattedWelcome = formatUserText(settings.welcome_text, ctx.from);
  return ctx.reply(formattedWelcome, { parse_mode: 'HTML' });
});

// Admin Panel Command
bot.command('settings', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return;
  const db = await getDb();
  const { panelText, keyboard } = await buildPanel(db);
  return ctx.reply(panelText, { parse_mode: 'Markdown', ...keyboard });
});

// Broadcast Command
bot.command('broadcast', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return;
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'config' },
    { $set: { admin_state: { mode: 'awaiting_broadcast_msg' } } }
  );
  return ctx.reply('📢 **Broadcast Mode:**\n\nPlease send or forward the message you want to broadcast to all users (Text, Photo, Video, etc.).\n\nSend /cancel to abort.', { parse_mode: 'Markdown' });
});

// Cancel command
bot.command('cancel', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return;
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'config' },
    { $unset: { admin_state: "" } }
  );
  return ctx.reply('🚫 Operation cancelled.');
});

// Settings Callback Actions
bot.action(/^(toggle_fsub|toggle_protect|toggle_autodel|set_time_\d+)$/, async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
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
  const { panelText, keyboard } = await buildPanel(db);
  return ctx.editMessageText(panelText, { parse_mode: 'Markdown', ...keyboard });
});

bot.action('manage_fsub', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
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
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return;
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'config' },
    { $set: { admin_state: { mode: 'awaiting_fsub_input' } } }
  );
  await ctx.answerCbQuery();
  return ctx.reply("Please send channel details in this format:\n\n`<Channel_ID>|<Channel_Title>|<Channel_Link>`\n\nExample:\n`-1004306300202|Backup Channel|https://t.me/yourbackup`", { parse_mode: 'Markdown' });
});

bot.action(/^del_fsub_(.+)$/, async (ctx) => {
  const chId = ctx.match[1];
  const db = await getDb();
  await db.collection('settings').updateOne({ _id: 'config' }, { $pull: { fsub_channels: { id: chId } } });
  await ctx.answerCbQuery('Channel Removed!');
  return ctx.reply('Channel removed successfully. Send /settings to refresh.');
});

bot.action('edit_welcome', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return;
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'config' },
    { $set: { admin_state: { mode: 'awaiting_welcome_text' } } }
  );
  await ctx.answerCbQuery();
  return ctx.reply("Please send your new /start Welcome Message.\n\nYou can use placeholders:\n• {mention}\n• {first_name}\n• {last_name}");
});

bot.action('edit_warning', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return;
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'config' },
    { $set: { admin_state: { mode: 'awaiting_warning_text' } } }
  );
  await ctx.answerCbQuery();
  return ctx.reply("Please send your Warning Message.\n\nPlaceholders available: {time}, {mention}");
});

bot.action('back_settings', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.deleteMessage();
});

// New Interactive /batch Command
bot.command('batch', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('📁 Selected Album', 'batch_mode_multi'),
      Markup.button.callback('↔️ Start & End Range', 'batch_mode_range')
    ],
    [
      Markup.button.callback('❌ Cancel', 'batch_mode_cancel')
    ]
  ]);

  return ctx.reply('Select Batch Mode:', keyboard);
});

// Batch Mode Actions
bot.action('batch_mode_multi', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'config' },
    { $set: { admin_state: { mode: 'awaiting_forward_multi', ids: [] } } }
  );
  await ctx.answerCbQuery();
  return ctx.editMessageText('Forward your selected files from DB Channel now.\nSend /cancel to abort.');
});

bot.action('batch_mode_range', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'config' },
    { $set: { admin_state: { mode: 'awaiting_range_start' } } }
  );
  await ctx.answerCbQuery();
  return ctx.editMessageText('Forward the FIRST file from DB Channel.\nSend /cancel to abort.');
});

bot.action('batch_mode_cancel', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'config' },
    { $unset: { admin_state: "" } }
  );
  await ctx.answerCbQuery();
  return ctx.editMessageText('Batch creation cancelled.');
});

bot.on(['message'], async (ctx) => {
  if (!ctx.from) return;
  const userId = ctx.from.id;

  if (String(userId) === ADMIN_ID) {
    const db = await getDb();
    const config = await db.collection('settings').findOne({ _id: 'config' });
    const state = config && config.admin_state ? config.admin_state : null;

    if (state && state.mode) {
      // 1. Handling Broadcast
      if (state.mode === 'awaiting_broadcast_msg') {
        await db.collection('settings').updateOne({ _id: 'config' }, { $unset: { admin_state: "" } });
        const statusMsg = await ctx.reply('⏳ Broadcasting message in progress...');

        const users = await db.collection('users').find({}, { projection: { _id: 1 } }).toArray();
        if (users.length === 0) {
          return ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            null,
            '⚠️ Total users in database is 0. No users to broadcast yet!'
          );
        }

        let success = 0;
        let failed = 0;

        for (const u of users) {
          try {
            await ctx.telegram.copyMessage(u._id, ctx.chat.id, ctx.message.message_id);
            success++;
          } catch (e) {
            failed++;
          }
        }

        return ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `📢 **Broadcast Completed!**\n\n✅ Success: \`${success}\`\n❌ Failed: \`${failed}\`\n👥 Total Targeted: \`${users.length}\``,
          { parse_mode: 'Markdown' }
        );
      }

      if (state.mode === 'awaiting_fsub_input') {
        const parts = ctx.message.text ? ctx.message.text.split('|') : [];
        if (parts.length === 3) {
          await db.collection('settings').updateOne(
            { _id: 'config' },
            { 
              $push: { fsub_channels: { id: parts[0].trim(), title: parts[1].trim(), link: parts[2].trim() } },$unset: { admin_state: "" }
            }
          );
          return ctx.reply('✅ FSUB Channel added successfully!');
        } else {
          return ctx.reply('❌ Invalid format. Please try again.');
        }
      } else if (state.mode === 'awaiting_welcome_text') {
        await db.collection('settings').updateOne(
          { _id: 'config' }, 
          { $set: { welcome_text: ctx.message.text },$unset: { admin_state: "" } }
        );
        return ctx.reply('✅ Welcome Message updated successfully!');
      } else if (state.mode === 'awaiting_warning_text') {
        await db.collection('settings').updateOne(
          { _id: 'config' }, 
          { $set: { warning_text: ctx.message.text },$unset: { admin_state: "" } }
        );
        return ctx.reply('✅ Warning Message updated successfully!');
      }

      // --- AUTO BATCH: RANGE FORWARD ---
      else if (state.mode === 'awaiting_range_start') {
        let fwdId = ctx.message.forward_from_message_id;
        if (!fwdId && ctx.message.text) {
          const m = ctx.message.text.match(/\/(\d+)$/) || [null, ctx.message.text];
          fwdId = parseInt(m[1]);
        }

        if (fwdId && !isNaN(fwdId)) {
          await db.collection('settings').updateOne(
            { _id: 'config' },
            { $set: { 'admin_state.mode': 'awaiting_range_end', 'admin_state.startId': fwdId } }
          );
          return ctx.reply(`First file saved (ID: ${fwdId}).\nNow forward the LAST file from DB Channel.`);
        } else {
          return ctx.reply('❌ Please forward a message from your DB Channel.');
        }
      } else if (state.mode === 'awaiting_range_end') {
        let fwdId = ctx.message.forward_from_message_id;
        if (!fwdId && ctx.message.text) {
          const m = ctx.message.text.match(/\/(\d+)$/) || [null, ctx.message.text];
          fwdId = parseInt(m[1]);
        }

        const startId = state.startId;
        const endId = fwdId;
        await db.collection('settings').updateOne({ _id: 'config' }, { $unset: { admin_state: "" } });

        if (startId && endId && startId <= endId) {
          const payload = Buffer.from(`${startId}-${endId}`).toString('base64');
          const link = `https://t.me/${BOT_USERNAME}?start=BATCH_${payload}`;
          return ctx.reply(`🔥 Hot Lanka Exclusive 🔥\n${link}`);
        } else {
          return ctx.reply('❌ Invalid IDs. Please run /batch to start again.');
        }
      }

      // --- AUTO BATCH: SELECTED / ALBUM FORWARD ---
      else if (state.mode === 'awaiting_forward_multi') {
        const fwdId = ctx.message.forward_from_message_id;
        if (!fwdId) {
          return ctx.reply('❌ Please forward messages from your DB Channel.');
        }

        // Push ID to MongoDB array atomically
        const updatedConfig = await db.collection('settings').findOneAndUpdate(
          { _id: 'config' },
          { $addToSet: { 'admin_state.ids': fwdId } },
          { returnDocument: 'after' }
        );

        const currentIds = (updatedConfig.value && updatedConfig.value.admin_state && updatedConfig.value.admin_state.ids) || [];

        // Wait 1.5 seconds for all forwarded messages in the album to arrive
        setTimeout(async () => {
          try {
            const freshConfig = await db.collection('settings').findOne({ _id: 'config' });
            if (freshConfig && freshConfig.admin_state && freshConfig.admin_state.mode === 'awaiting_forward_multi') {
              const allIds = freshConfig.admin_state.ids || [];
              if (allIds.length > 0) {
                // Clear state
                await db.collection('settings').updateOne({ _id: 'config' }, { $unset: { admin_state: "" } });
                const minId = Math.min(...allIds);
                const maxId = Math.max(...allIds);
                const payload = Buffer.from(`${minId}-${maxId}`).toString('base64');
                const link = `https://t.me/${BOT_USERNAME}?start=BATCH_${payload}`;
                return ctx.reply(`🔥 Hot Lanka Exclusive 🔥\n${link}`);
              }
            }
          } catch (e) {
            console.error('Batch multi error:', e);
          }
        }, 1500);

        return;
      }
    }

    // Direct Forward/Media upload to DB channel (Single file upload)
    const isMedia = ctx.message.document || ctx.message.video || ctx.message.photo || ctx.message.audio;
    if (isMedia) {
      try {
        // If forwarded directly from DB Channel, use its ID directly
        if (ctx.message.forward_from_chat && String(ctx.message.forward_from_chat.id) === DB_CHANNEL_ID && ctx.message.forward_from_message_id) {
          const encoded = Buffer.from(String(ctx.message.forward_from_message_id)).toString('base64');
          const fileLink = `https://t.me/${BOT_USERNAME}?start=${encoded}`;
          return ctx.reply(`🔥 Hot Lanka Exclusive 🔥\n${fileLink}`);
        }

        // Otherwise copy to DB Channel
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

// Admin Commands Scope
bot.telegram.setMyCommands([
  { command: 'start', description: 'Start the bot & get files' },
  { command: 'settings', description: 'Open admin control panel' },
  { command: 'batch', description: 'Create a batch link for files' },
  { command: 'broadcast', description: 'Broadcast message to users' },
  { command: 'cancel', description: 'Cancel current operation' }
], {
  scope: { type: 'chat', chat_id: Number(ADMIN_ID) }
}).catch(err => console.error('Error setting admin commands:', err.message));

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      if (req.body && typeof req.body === 'object') {
        await bot.handleUpdate(req.body);
      }
    } catch (err) {
      console.error('Webhook error:', err);
    }
    return res.status(200).send('OK');
  }
  return res.status(200).send('Bot is active!');
};
