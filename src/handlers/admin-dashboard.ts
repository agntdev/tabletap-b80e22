import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { adminChatId, inlineButton, inlineKeyboard, registerMainMenuItem, requireOwner } from "../toolkit/index.js";
import { audit, availableSlots, loadState, saveState, today } from "../domain.js";

registerMainMenuItem({ label: "Today's dashboard", data: "admin:dashboard", order: 90 });
const composer = new Composer<Ctx>();
composer.callbackQuery("admin:dashboard", async ctx => { if (!(await requireOwner(ctx as never))) return; await ctx.answerCallbackQuery(); const state = await loadState(ctx); const day = today(); const list = state.bookings.filter(b => b.date === day && b.status !== "cancelled"); const lines = list.length ? list.map(b => `${b.time} · ${b.partySize} people · ${b.ref}${b.status === "no-show" ? " · no-show" : ""}`).join("\n") : "No bookings today."; const capacity = Object.entries(state.settings.tables).map(([size, count]) => `${count} × ${size}-seat`).join(", "); const remaining = availableSlots(state, day, 2).length; const actions = list.slice(0, 8).map(b => [inlineButton(`No-show ${b.ref}`, `admin:booking:${b.ref}:no-show`), inlineButton(`Cancel ${b.ref}`, `admin:booking:${b.ref}:cancel`)]); await ctx.reply(`Today's bookings\n${lines}\n\nTables: ${capacity}\nAvailable 2-person slots: ${remaining}`, { reply_markup: inlineKeyboard(actions.concat([[inlineButton("Back to menu", "menu:main")]])) }); });
composer.callbackQuery(/^admin:booking:([A-Z0-9]{6}):(no-show|cancel)$/, async ctx => { if (!(await requireOwner(ctx as never))) return; await ctx.answerCallbackQuery(); const state = await loadState(ctx); const b = state.bookings.find(x => x.ref === ctx.match[1]); if (!b) { await ctx.reply("I couldn't find that booking."); return; } b.status = ctx.match[2] === "no-show" ? "no-show" : "cancelled"; audit(state, ctx.match[2] === "no-show" ? "no_show_marked" : "cancel", "owner", b.id); await saveState(ctx, state); await ctx.reply(ctx.match[2] === "no-show" ? `Booking ${b.ref} is marked no-show.` : `Booking ${b.ref} is cancelled.`); });
void adminChatId;
export default composer;
