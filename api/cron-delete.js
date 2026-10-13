const { MongoClient } = require('mongodb');
const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;

const bot = new Telegraf(BOT_TOKEN);

module.exports = async (req, res) => {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db('file_store_bot');
    const now = new Date();

    // Find all expired records
    const expiredRecords = await db.collection('deletion_queue').find({ delete_at: { $lte: now } }).toArray();

    for (const record of expiredRecords) {
      for (const msgId of record.message_ids) {
        try {
          await bot.telegram.deleteMessage(record.chat_id, msgId);
        } catch (e) {
          // Message already deleted by user or not found
        }
        // Small delay to prevent rate limits
        await new Promise(r => setTimeout(r, 60));
      }
      // Remove deleted item from queue
      await db.collection('deletion_queue').deleteOne({ _id: record._id });
    }

    await client.close();
    return res.status(200).json({ success: true, deletedCount: expiredRecords.length });
  } catch (err) {
    console.error('Cron Delete Error:', err);
    return res.status(500).json({ error: err.message });
  }
};
