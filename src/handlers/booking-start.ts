import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { addDays, audit, availableSlots, loadState, newId, newRef, now, saveState, today } from "../domain.js";

registerMainMenuItem({ label: "Book a table", data: "booking:start", order: 10 });
const composer = new Composer<Ctx>();
const force = (placeholder: string) => ({ force_reply: true as const, input_field_placeholder: placeholder });
const back = inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]);
function partyKeyboard() { return inlineKeyboard([[inlineButton("2 people", "booking:party:2"), inlineButton("4 people", "booking:party:4")], [inlineButton("6 people", "booking:party:6"), inlineButton("Other", "booking:party:other")], [inlineButton("Back to menu", "menu:main")]]); }

composer.callbackQuery("booking:start", async ctx => { await ctx.answerCallbackQuery(); ctx.session.step = "party_size"; await ctx.reply("How many people are you booking for?", { reply_markup: partyKeyboard() }); });
composer.callbackQuery(/^booking:party:(2|4|6)$/, async ctx => { await ctx.answerCallbackQuery(); const size = Number(ctx.match[1]); ctx.session.partySize = size; ctx.session.step = "date"; await showDates(ctx); });
composer.callbackQuery("booking:party:other", async ctx => { await ctx.answerCallbackQuery(); ctx.session.step = "party_size"; await ctx.reply("Send the party size as a number from 1 to 20.", { reply_markup: force("Party size") }); });
composer.callbackQuery(/^booking:date:(\d{4}-\d{2}-\d{2})$/, async ctx => { await ctx.answerCallbackQuery(); ctx.session.date = ctx.match[1]; ctx.session.step = "time"; await showTimes(ctx); });
composer.callbackQuery(/^booking:time:(\d{2}:\d{2})$/, async ctx => { await ctx.answerCallbackQuery(); ctx.session.time = ctx.match[1]; ctx.session.step = "name"; await ctx.reply("What name should I put on the booking? You can skip this.", { reply_markup: force("Name or Skip") }); });
composer.callbackQuery("booking:skip-name", async ctx => { await ctx.answerCallbackQuery(); ctx.session.name = undefined; ctx.session.step = "phone"; await ctx.reply("What phone number should we use? You can skip this.", { reply_markup: force("Phone or Skip") }); });
composer.callbackQuery("booking:skip-phone", async ctx => { await ctx.answerCallbackQuery(); ctx.session.phone = undefined; await finish(ctx); });

composer.on("message:text", async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (ctx.session.step === "party_size") { const n = Number(text); if (!Number.isInteger(n) || n < 1 || n > 20) { await ctx.reply("Send a whole number from 1 to 20."); return; } ctx.session.partySize = n; ctx.session.step = "date"; await showDates(ctx); return; }
  if (ctx.session.step === "name") { ctx.session.name = /^skip$/i.test(text) ? undefined : text.slice(0, 80); ctx.session.step = "phone"; await ctx.reply("What phone number should we use? You can skip this.", { reply_markup: force("Phone or Skip") }); return; }
  if (ctx.session.step === "phone") { ctx.session.phone = /^skip$/i.test(text) ? undefined : text.slice(0, 40); await finish(ctx); return; }
  await next();
});

async function showDates(ctx: Ctx) { const state = await loadState(ctx); const size = ctx.session.partySize ?? 2; const rows = []; for (let i = 0; i < 7; i++) { const date = addDays(today(), i); if (availableSlots(state, date, size).length) rows.push([inlineButton(i === 0 ? "Today" : date, `booking:date:${date}`)]); } await ctx.reply(rows.length ? "Pick a date that works for you." : "There are no tables available in the next few days.", { reply_markup: rows.length ? inlineKeyboard(rows.concat([[inlineButton("Back to menu", "menu:main")]])) : back }); }
async function showTimes(ctx: Ctx) { const state = await loadState(ctx); const date = ctx.session.date ?? today(); const times = availableSlots(state, date, ctx.session.partySize ?? 2); const rows = []; for (let i = 0; i < times.length; i += 3) rows.push(times.slice(i, i + 3).map(time => inlineButton(time, `booking:time:${time}`))); await ctx.reply(times.length ? "Pick a time — these slots still have room." : "That date just filled up. Pick another date.", { reply_markup: times.length ? inlineKeyboard(rows.concat([[inlineButton("Choose another date", "booking:start")]])) : back }); }
async function finish(ctx: Ctx) { const state = await loadState(ctx); const partySize = ctx.session.partySize ?? 0; const date = ctx.session.date ?? today(); const time = ctx.session.time ?? ""; if (!availableSlots(state, date, partySize).includes(time)) { ctx.session.step = "time"; await ctx.reply("That time was just taken. Pick another available slot."); await showTimes(ctx); return; } const booking = { id: newId(), ref: newRef(state), chatId: ctx.chat?.id ?? 0, partySize, date, time, name: ctx.session.name, phone: ctx.session.phone, status: "confirmed" as const, createdAt: now().toISOString(), updatedAt: now().toISOString(), rescheduleCount: 0 }; state.bookings.push(booking); audit(state, "create", "guest", booking.id, `${partySize} people at ${date} ${time}`); await saveState(ctx, state); ctx.session.step = "idle"; await ctx.reply(`You're booked for ${date} at ${time}.\nReference: ${booking.ref}`, { reply_markup: inlineKeyboard([[inlineButton("Reschedule", `booking:reschedule:${booking.ref}`), inlineButton("Cancel", `booking:cancel:${booking.ref}`)], [inlineButton("View details", `booking:details:${booking.ref}`), inlineButton("Back to menu", "menu:main")]]) }); const owner = (ctx as Ctx & { env?: Record<string, unknown> }).env?.ADMIN_CHAT_ID ?? (typeof process === "undefined" ? undefined : process.env.ADMIN_CHAT_ID); if (owner) { try { await ctx.api.sendMessage(String(owner), `New booking ${booking.ref}: ${partySize} people on ${date} at ${time}.`); } catch { /* Telegram failures must not undo a saved booking. */ } } }
export default composer;
