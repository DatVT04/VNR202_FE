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

const NEKO_KEY = 'vnr202_neko_enabled';
const TOTAL_VISITS_KEY = 'vnr202_total_visits';

// Ngày theo giờ Việt Nam (UTC+7) để "hôm nay" reset đúng lúc nửa đêm ở VN
function todayKeyVN() {
  const vn = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return vn.toISOString().slice(0, 10); // YYYY-MM-DD
}

export default async function handler(req, res) {
  const now = Date.now();
  const activeThreshold = now - 15000; // 15 seconds ago
  const dayKey = `vnr202_learners:${todayKeyVN()}`;

  try {
    const redis = await getRedisClient();

    let totalVisits = null;

    if (req.method === 'POST') {
      const { userId, nekoEnabled, isNewVisit } = req.body || {};

      if (userId) {
        // Add or update user's last seen timestamp
        await redis.zAdd('active_learners', { score: now, value: userId });

        // Đếm số người KHÁC NHAU học trong ngày (HyperLogLog: nhẹ, không phình)
        await redis.pfAdd(dayKey, userId);
        // Giữ 60 ngày rồi tự xoá cho khỏi rác
        await redis.expire(dayKey, 60 * 60 * 24 * 60);
      }

      // Mỗi lần mở trang mới mới tính là một lượt truy cập
      if (isNewVisit) {
        totalVisits = await redis.incr(TOTAL_VISITS_KEY);
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

    // Số người học hôm nay
    const todayLearners = await redis.pfCount(dayKey);

    if (totalVisits === null) {
      const raw = await redis.get(TOTAL_VISITS_KEY);
      totalVisits = raw ? Number(raw) : 0;
    }

    // Read current neko state (default to enabled if not set)
    const nekoState = await redis.get(NEKO_KEY);
    const nekoEnabled = nekoState === null ? true : nekoState === '1';

    return res.status(200).json({
      activeCount: count,
      todayLearners,
      totalVisits,
      nekoEnabled,
    });
  } catch (error) {
    console.error('Redis error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
