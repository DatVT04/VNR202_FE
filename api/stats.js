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

const ACTIVE_WINDOW_MS = 15 * 1000;        // im lặng quá 15 giây thì coi như đã rời đi
const SESSION_GAP_MS = 30 * 60 * 1000;     // nghỉ quá 30 phút thì lần vào sau tính là phiên mới

// Ngày theo giờ Việt Nam (UTC+7) để "hôm nay" reset đúng lúc nửa đêm ở VN
function todayKeyVN() {
  const vn = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return vn.toISOString().slice(0, 10); // YYYY-MM-DD
}

/*
 * userId từ client có dạng "<vânTayThiếtBị>-<mãNgẫuNhiên>".
 *
 * - Phần vân tay dùng để nhận DIỆN NGƯỜI: xoá cache hay bật ẩn danh thì mã
 *   ngẫu nhiên đổi nhưng vân tay giữ nguyên, nên vẫn gom về một người.
 * - Toàn bộ chuỗi dùng cho "đang học", vì hai profile trình duyệt mở song song
 *   trên cùng máy thì đúng là hai phiên học riêng.
 */
function personKey(userId) {
  const raw = String(userId || '');
  const dash = raw.indexOf('-');
  return dash > 0 ? raw.slice(0, dash) : raw;
}

export default async function handler(req, res) {
  const now = Date.now();
  const dayKey = `vnr202_learners:${todayKeyVN()}`;

  try {
    const redis = await getRedisClient();

    if (req.method === 'POST') {
      const { userId, nekoEnabled } = req.body || {};

      if (userId) {
        const person = personKey(userId);
        const lastSeenKey = `vnr202_lastseen:${person}`;

        // Đang học: theo từng phiên trình duyệt
        await redis.zAdd('active_learners', { score: now, value: String(userId) });

        // Học hôm nay: theo NGƯỜI, không theo số tab hay số lần mở
        await redis.pfAdd(dayKey, person);
        await redis.expire(dayKey, 60 * 60 * 24 * 60); // giữ 60 ngày

        /* Lượt vào = số PHIÊN, do server quyết định chứ không tin client.
           Chỉ cộng khi người này đã nghỉ hơn 30 phút. Nhờ vậy F5 liên tục hay
           mở 5 tab cùng lúc cũng chỉ tính đúng 1 lượt. */
        const lastSeen = await redis.get(lastSeenKey);
        if (!lastSeen || now - Number(lastSeen) > SESSION_GAP_MS) {
          await redis.incr(TOTAL_VISITS_KEY);
        }
        await redis.set(lastSeenKey, String(now), { EX: 60 * 60 * 24 * 2 });
      }

      // Update neko state if provided
      if (typeof nekoEnabled === 'boolean') {
        await redis.set(NEKO_KEY, nekoEnabled ? '1' : '0');
      }
    }

    // Dọn những ai đã im lặng quá lâu rồi mới đếm
    await redis.zRemRangeByScore('active_learners', 0, now - ACTIVE_WINDOW_MS);
    const activeCount = await redis.zCard('active_learners');

    const todayLearners = await redis.pfCount(dayKey);

    const rawVisits = await redis.get(TOTAL_VISITS_KEY);
    const totalVisits = rawVisits ? Number(rawVisits) : 0;

    // Read current neko state (default to enabled if not set)
    const nekoState = await redis.get(NEKO_KEY);
    const nekoEnabled = nekoState === null ? true : nekoState === '1';

    return res.status(200).json({
      activeCount,
      todayLearners,
      totalVisits,
      nekoEnabled,
    });
  } catch (error) {
    console.error('Redis error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
