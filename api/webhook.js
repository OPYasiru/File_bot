const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_CHANNEL_ID = process.env.DB_CHANNEL_ID;
const ADMIN_ID = String(process.env.ADMIN_ID);
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
      fsub_channels: [], // array of { id, title, link }
      protect_content: true,
      auto_delete: true,
      delete_delay_minutes: 180, // Default 3 hours
      welcome_text: "👋 සාදරයෙන් පිළිගන්නවා! Files ලබා ගැනීමට අදාළ ලින්ක් එක click කරන්න.",
      warning_text: "⚠️ Important:\n\nAll Messages deleted after {time}\n\n👑 HOT LANKA VIP ACCESS\n💰 ගාස්තුව: Rs. 500/= පමණි\n📩 VIP ලබාගැනීමට: @LankaAdmin_bot"
    };
    await col.insertOne(s);
  }
  return s;
}

const bot = new Telegraf(BOT_TOKEN);

// User state helper for admin inputs
const adminStates = {};

// Helper: Check FSUB
async function checkFsub(ctx, userId, channels) {
  const notJoined = [];
  for (const ch of channels) {
    try {
      const member = await ctx.telegram.getChatMember(ch.id, userId);
      if (['left', 'kicked'].includes(member.status)) {
        notJoined.push(ch);
      }
    } catch (e) {
      console.error(`FSUB Error for ${ch.id}:`, e.message);
    }
  }
  return notJoined;
}

// Format time
function formatDuration(mins) {
  if (mins < 60) return `${mins} minutes`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} hour${hrs > 1 ? 's' : ''}`;
}

// /start Handler
bot.start(async (ctx) => {
  const db = await getDb();
  const settings = await getSettings(db);
  const payload = ctx.startPayload;
  const userId = ctx.from.id;

  // Single file or Batch
  if (payload) {
    // Check Force Sub if enabled
    if (settings.fsub_enabled && settings.fsub_channels.length > 0) {
      const pendingChannels = await checkFsub(ctx, userId, settings.fsub_channels);
      if (pendingChannels.length > 0) {
        const buttons = pendingChannels.map(ch => [Markup.button.url(`📢 Join ${ch.title || 'Channel'}`, ch.link)]);
        buttons.push([Markup.button.url('🔄 Try Again', `https://t.me/${BOT_USERNAME}?start=${payload}`)]);
        return ctx.reply('⚠️ Files ලබා ගැනීමට පහත Channels වලට Join වන්න:', Markup.inlineKeyboard(buttons));
      }
    }

    let msgIdsToSend = [];
    if (payload.startsWith('BATCH_')) {
      const rangeStr = Buffer.from(payload.replace('BATCH_', ''), 'base64').toString('ascii');
      const [startId, endId] = rangeStr.split('-').map(Number);
      if (startId && endId && startId <= endId) {
        for (let i = startId; i <= endId; i++) msgIdsToSend.push(i);
      }
    } else {
      const singleId = Number(Buffer.from(payload, 'base64').toString('ascii'));
      if (singleId) msgIdsToSend.push(singleId);
    }

    if (msgIdsToSend.length === 0) {
      return ctx.reply('❌ Invalid හෝ Expire වූ link එකක්.');
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
        console.error('Error copying msg:', err.message);
      }
    }

    // Send Warning Message
    const warnText = settings.warning_text.replace('{time}', formatDuration(settings.delete_delay_minutes));
    const warnMsg = await ctx.reply(warnText);
    sentMsgIds.push(warnMsg.message_id);

    // Schedule deletion if enabled
    if (settings.auto_delete) {
      const deleteAt = new Date(Date.now() + settings.delete_delay_minutes * 60 * 1000);
      await db.collection('deletion_queue').insertOne({
        chat_id: ctx.chat.id,
        message_ids: sentMsgIds,
        delete_at: deleteAt
      });
    }
    return;
  }

  // Normal /start welcome message
  return ctx.reply(settings.welcome_text);
});

// Admin Panel Command
bot.command('settings', async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) return;
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
});

// Settings Callback Actions
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
  // Refresh panel
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

// Manage FSUB Channels Menu
bot.action('manage_fsub', async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  const db = await getDb();
  const settings = await getSettings(db);

  let listText = "📢 **FSUB Channels List:**\n\n";
  const buttons = [];

  if (settings.fsub_channels.length === 0) {
    listText += "දැනට channels කිසිවක් නැත.\n";
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
  return ctx.reply("කරුණාකර Channel විස්තර පහත ආකෘතියට එවන්න:\n\n`<Channel_ID>|<Channel_Title>|<Channel_Link>`\n\nඋදාහරණ:\n`-1001234567890|My Channel|https://t.me/mychannel`");
});

bot.action(/^del_fsub_(.+)$/, async (ctx) => {
  const chId = ctx.match[1];
  const db = await getDb();
  await db.collection('settings').updateOne({ _id: 'config' }, { $pull: { fsub_channels: { id: chId } } });
  await ctx.answerCbQuery('Channel Removed!');
  return ctx.reply('Channel එක සාර්ථකව ඉවත් කළා. `/settings` වෙතින් නැවත බලන්න.');
});

bot.action('edit_welcome', async (ctx) => {
  adminStates[ctx.from.id] = 'awaiting_welcome_text';
  await ctx.answerCbQuery();
  return ctx.reply("කරුණාකර අලුත් /start Welcome Message එක එවන්න:");
});

bot.action('edit_warning', async (ctx) => {
  adminStates[ctx.from.id] = 'awaiting_warning_text';
  await ctx.answerCbQuery();
  return ctx.reply("කරුණාකර Warning Message එක එවන්න ({time} ලෙස යෙදූ විට auto-delete වෙලාව replace වේ):");
});

bot.action('back_settings', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.deleteMessage();
});

// Admin /batch Command
bot.command('batch', async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) return;
  adminStates[ctx.from.id] = 'awaiting_batch_start';
  return ctx.reply('📦 Batch Creation:\nකරුණාකර Channel එකේ පළමු file එකේ Message Link එක (හෝ Message ID) එවන්න:');
});

// Handle Media / Files forwarded to bot by Admin (Instant Single File Link)
bot.on(['message'], async (ctx) => {
  const userId = ctx.from.id;
  const state = adminStates[userId];

  // Handle Admin Input states
  if (String(userId) === ADMIN_ID && state) {
    const db = await getDb();
    if (state === 'awaiting_fsub_input') {
      const parts = ctx.message.text ? ctx.message.text.split('|') : [];
      if (parts.length === 3) {
        await db.collection('settings').updateOne(
          { _id: 'config' },
          { $push: { fsub_channels: { id: parts[0].trim(), title: parts[1].trim(), link: parts[2].trim() } } }
        );
        delete adminStates[userId];
        return ctx.reply('✅ FSUB Channel එක සාර්ථකව add කළා!');
      } else {
        return ctx.reply('❌ වැරදි format එකක්. නැවත උත්සාහ කරන්න.');
      }
    } else if (state === 'awaiting_welcome_text') {
      await db.collection('settings').updateOne({ _id: 'config' }, { $set: { welcome_text: ctx.message.text } });
      delete adminStates[userId];
      return ctx.reply('✅ Welcome Message එක update කළා!');
    } else if (state === 'awaiting_warning_text') {
      await db.collection('settings').updateOne({ _id: 'config' }, { $set: { warning_text: ctx.message.text } });
      delete adminStates[userId];
      return ctx.reply('✅ Warning Message එක update කළා!');
    } else if (state === 'awaiting_batch_start') {
      const text = ctx.message.text || '';
      const match = text.match(/\/(\d+)$/) || [null, text];
      adminStates[userId] = { type: 'batch', startId: parseInt(match[1]) };
      return ctx.reply('නියමයි! දැන් අවසාන file එකේ Message Link එක (හෝ Message ID) එවන්න:');
    } else if (typeof state === 'object' && state.type === 'batch') {
      const text = ctx.message.text || '';
      const match = text.match(/\/(\d+)$/) || [null, text];
      const endId = parseInt(match[1]);
      const startId = state.startId;
      delete adminStates[userId];

      if (startId && endId && startId <= endId) {
        const payload = Buffer.from(`${startId}-${endId}`).toString('base64');
        const link = `https://t.me/${BOT_USERNAME}?start=BATCH_${payload}`;
        return ctx.reply(`🔥 Hot Lanka Exclusive 🔥\n\n${link}\n\n✅ Batch created for messages ${startId} to ${endId}!`);
      } else {
        return ctx.reply('❌ වැරදි Message IDs. නැවත /batch හරහා උත්සාහ කරන්න.');
      }
    }
  }

  // Admin sending a single media to store
  if (String(userId) === ADMIN_ID) {
    const isMedia = ctx.message.document || ctx.message.video || ctx.message.photo || ctx.message.audio;
    if (isMedia) {
      try {
        const copied = await ctx.telegram.copyMessage(DB_CHANNEL_ID, ctx.chat.id, ctx.message.message_id);
        const encoded = Buffer.from(String(copied.message_id)).toString('base64');
        const fileLink = `https://t.me/${BOT_USERNAME}?start=${encoded}`;

        return ctx.reply(
          `🔥 Hot Lanka Exclusive 🔥\n\n${fileLink}\n\n✅ Post published successfully!`,
          Markup.inlineKeyboard([[Markup.button.url('🔗 Share URL', `https://t.me/share/url?url=${encodeURIComponent(fileLink)}`)]])
        );
      } catch (e) {
        console.error('Error storing single file:', e);
        return ctx.reply(`❌ File එක Database Channel එකට දැමීමට නොහැකි විය: ${e.message}`);
      }
    }
  }
});

// Vercel Serverless Handler
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      await bot.handleUpdate(req.body);
    } catch (err) {
      console.error('Webhook error:', err);
    }
    return res.status(200).send('OK');
  }
  return res.status(200).send('Bot is active!');
};
