import "dotenv/config";
import { sendMessage } from "../lib/telegram";
const botToken = process.env.TELEGRAM_BOT_TOKEN!;
const chatId = process.env.TELEGRAM_CHANNEL_ID!;
await sendMessage({ botToken, chatId }, "monitor online ✅");
console.log("sent");
