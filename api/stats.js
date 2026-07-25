import { createClient } from 'redis';

// Singleton connection to avoid multiple connections in serverless environment
let client;

async function getRedisClient() {
  if (!client) {
    client = createClient({
      url: process.env.REDIS_URL || process.env.KV_URL
    });
    client.on('error', (err) => console.error('Redis Client Error', err));
    await client.connect();
  }
  return client;
}

const NEKO_KEY = 'quiznet_neko_enabled';

export default async function handler(req, res) {
  const now = Date.now();
  const activeThreshold = now - 15000; // 15 seconds ago

  try {
    const redis = await getRedisClient();

    if (req.method === 'POST') {
      const { userId, nekoEnabled } = req.body;
      if (userId) {
        // Add or update user's last seen timestamp
        await redis.zAdd('active_learners', { score: now, value: userId });
      }

      // Update neko state if provided
      if (typeof nekoEnabled === 'boolean') {
        await redis.set(NEKO_KEY, nekoEnabled ? '1' : '0');
      }
    }

    // Remove users who haven't been seen for more than 30 seconds
    await redis.zRemRangeByScore('active_learners', 0, activeThreshold);
    
    // Count remaining active users
    const count = await redis.zCard('active_learners');

    // Read current neko state (default to enabled if not set)
    const nekoState = await redis.get(NEKO_KEY);
    const nekoEnabled = nekoState === null ? true : nekoState === '1';

    return res.status(200).json({ activeCount: count, nekoEnabled });
  } catch (error) {
    console.error('Redis error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
