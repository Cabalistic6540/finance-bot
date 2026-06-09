const express = require('express');
const app = express();
app.use(express.json());

const CHANNEL_ACCESS_TOKEN = '4AorV6TX61DNZHcbS94YJN3EjSqAzXgAXgw5ULLJCTKNBUrJ8cFaKdGVzjfHP49Hw+XHk25POoHpykxZQlXTWT48v/fAOVeaKoc89lmQNc0Y0XfaEyl+7IdVeY/xgVR0RxzwKHy04xbyZiTtz2nJKgdB04t89/1O/w1cDnyilFU=';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const DEBT_NAMES = ['UMAY+', 'บัตรเครดิต', 'กยศ.', 'Shopee Pay', 'First Choice', 'Promise', 'LINE BK', 'TikTok PayLater', 'ค่าประกัน'];

async function replyMessage(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  });
}

async function pushMessage(to, text) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  });
}

async function getImageContent(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` },
  });
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

async function analyzeWithClaude(imageBase64) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: `รูปนี้เป็นหน้าจอแอพหนี้หรือสลิป อ่านข้อมูลและตอบเป็น JSON เท่านั้น ไม่ต้องมีข้อความอื่น:
{"debtName": "ชื่อหนี้", "balance": ตัวเลข, "minPay": ตัวเลขหรือ null, "dueDay": ตัวเลขหรือ null}

รายชื่อหนี้ที่มี: ${DEBT_NAMES.join(', ')}
เลือกชื่อที่ใกล้เคียงที่สุด` }
        ]
      }]
    }),
  });
  const data = await res.json();
  console.log('Claude response:', JSON.stringify(data));
  const text = data.content?.map(c => c.text || '').join('');
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

app.post('/webhook', async (req, res) => {
  const events = req.body?.events || [];
  res.status(200).json({ ok: true });

  for (const event of events) {
    const userId = event.source?.userId;
    const groupId = event.source?.groupId;
    const to = groupId || userId;

    if (event.type === 'message' && event.message.type === 'image') {
      await replyMessage(event.replyToken, '⏳ กำลังอ่านรูป รอแป๊บนึงครับ...');
      try {
        const imageBase64 = await getImageContent(event.message.id);
        const result = await analyzeWithClaude(imageBase64);
        const lines = [
          `✅ อ่านได้แล้วครับ`,
          `📋 หนี้: ${result.debtName}`,
          `💰 ยอดคงเหลือ: ฿${Number(result.balance).toLocaleString('th-TH')}`,
          result.minPay ? `⚡ ขั้นต่ำ: ฿${Number(result.minPay).toLocaleString('th-TH')}` : null,
          result.dueDay ? `📅 ครบกำหนด: วันที่ ${result.dueDay}` : null,
          ``,
          `⚠️ ตรวจสอบตัวเลขก่อนนำไปใช้นะครับ`,
        ].filter(Boolean).join('\n');
        await pushMessage(to, lines);
     } catch (err) {
        console.error('Error:', err.message, JSON.stringify(err));
        await pushMessage(to, '❌ อ่านรูปไม่ได้ครับ ลองส่งใหม่อีกครั้ง');
      }
    } else if (event.type === 'message' && event.message.type === 'text') {
      await replyMessage(event.replyToken, '📷 ส่งรูปหน้าจอแอพหนี้มาได้เลยครับ จะอ่านยอดให้อัตโนมัติ');
    }
  }
});

app.get('/', (req, res) => res.send('Finance Bot running!'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
