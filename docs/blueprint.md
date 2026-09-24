# TableReserve — Bot specification

**Archetype:** booking

**Voice:** warm and concise — write every user-facing message, button label, error, and empty state in this voice.

A Telegram-first table-reservation bot that shows only truly available slots, lets guests book/reschedule/cancel via inline buttons, sends short-reference confirmations and configurable reminders, and notifies the owner (ADMIN_CHAT_ID) with a compact daily dashboard and booking events. All bookings, settings, and audit events persist so availability checks remain authoritative across restarts.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Restaurant guests seeking fast Telegram bookings
- Restaurant owner and staff who manage daily capacity and bookings

## Success criteria

- Guests can complete a booking via buttons in a single conversational flow and receive a 6-char reference code
- Bot only offers time slots that truly have tables available for the requested party size
- Guests can reschedule or cancel a booking via inline buttons and owner is notified of each event
- Reminders are sent to guests at the configured lead time and owner receives daily summaries and no-show flags
- Admin notifications and dashboard reflect live capacity and persist across bot restarts

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open the main menu and begin booking flow
- **Book table** (button, actor: user, callback: booking:start) — Begin a new booking flow (party size → date → time → optional contact → confirm)
  - inputs: party_size (via buttons or custom number via ForceReply), date selection (button calendar pages), time slot (button)
  - outputs: proposed booking summary, short reference code, confirmation message
- **My booking (ref code)** (button, actor: user, callback: booking:lookup) — Lookup, view, cancel or reschedule an existing booking by entering reference code
  - inputs: reference_code (ForceReply)
  - outputs: booking details, action buttons (Reschedule, Cancel, View Details)
- **/help** (command, actor: user, command: /help) — Show brief instructions and owner contact info
- **Admin: Today's dashboard** (button, actor: owner, callback: admin:dashboard) — Owner/admin opens compact dashboard of today's bookings and remaining capacity (owner only)
  - inputs: authenticated owner chat (ADMIN_CHAT_ID)
  - outputs: today's bookings list, remaining capacity summary

## Flows

### Guest booking (new)
_Trigger:_ /start or booking:start callback

1. Bot greets and prompts for party size with common size buttons (2,4,6,Other)
2. User selects or enters party size (ForceReply for custom)
3. Bot shows next available dates (paginated buttons) that have at-least-one-available-slot for that party size
4. User selects date
5. Bot lists only truly available time slots for that date as buttons (slot→availability check)
6. User selects time slot
7. Bot asks for optional name (skip allowed) via ForceReply
8. Bot asks for optional phone (skip allowed) via ForceReply
9. Bot reserves slot tentatively, creates Booking record with status 'confirmed', assigns table(s), generates 6-char ref code
10. Bot sends confirmation to guest with reference code and inline actions: Reschedule, Cancel, View Details
11. Owner notification sent to ADMIN_CHAT_ID with booking summary

_Data touched:_ Settings, TableInventory, Booking, AuditEvent, UserSession, Reminder

### Availability calculation & slot generation
_Trigger:_ party size selection or date page open

1. Load Settings and TableInventory for the weekday
2. Generate discrete candidate slots every 15 minutes within opening hours
3. For each slot, compute table assignments required for party size using greedy bin-packing by table sizes
4. Exclude slots where required tables exceed available inventory considering existing confirmed bookings overlapping the slot (taking sitting length into account)
5. Return only slots with at least one valid table assignment

_Data touched:_ Settings, TableInventory, Booking

### Reschedule flow
_Trigger:_ User taps Reschedule (guest) or owner requests reschedule

1. Verify action via short confirmation (inline Yes/No)
2. Show available dates and times (same availability rules) excluding the current slot
3. User picks new date/time
4. Atomically reserve new slot, mark old booking as 'rescheduled' (retain ref), update booking timestamps and table assignment, free old tables
5. Send updated confirmation to guest and notify owner

_Data touched:_ Booking, TableInventory, AuditEvent

### Cancellation flow
_Trigger:_ User taps Cancel or owner cancels

1. Ask for cancellation confirmation (inline Yes/No)
2. If confirmed, set booking status to 'cancelled', free assigned tables, send cancellation confirmation to guest, notify ADMIN_CHAT_ID
3. Record audit event

_Data touched:_ Booking, TableInventory, AuditEvent

### Reminder delivery
_Trigger:_ scheduled job at configured lead time before booking

1. Query upcoming bookings with status 'confirmed' and pending reminders
2. Send reminder message to guest (if phone/name provided, include them in message optionally), include ref code and actions (Cancel, Reschedule)
3. If delivery fails (user blocked bot or chat errors), record delivery failure in audit and notify owner daily in summary

_Data touched:_ Booking, Reminder, AuditEvent

### Admin dashboard & actions
_Trigger:_ owner opens admin:dashboard or scheduled daily summary

1. Verify sender is ADMIN_CHAT_ID
2. Return compact list of today's bookings, capacities by table size, remaining available slots count, and no-show flags
3. Owner may tap a booking to view details and mark as 'no-show' or 'cancel'
4. Actions update booking status and generate audit events

_Data touched:_ Booking, Settings, AuditEvent

### Concurrent booking / race handling
_Trigger:_ two users attempt same slot simultaneously

1. When user selects time slot, attempt atomic reservation with a transaction/lock on slot inventory for the overlapping interval
2. If reservation fails (no tables left), inform the user immediately and refresh available slot list
3. If reservation succeeds, persist booking and proceed to confirmation

_Data touched:_ TableInventory, Booking, AuditEvent

## Owner-supplied settings

The OWNER provides these; they are collected in chat and injected into the environment at deploy. Read each one from the environment where it is used (`ctx.env.<KEY>` / `env.<KEY>` on Cloudflare Workers; `process.env.<KEY>` only as a Node/harness fallback — never the sole read). Do NOT invent your own way of learning the value, do NOT ask for it in a bot message, and do NOT hardcode a default.

- **ADMIN_CHAT_ID** — Where new bookings, cancellations, reschedules, daily summaries, and no-show notifications are delivered (owner/admin Telegram chat id)
  - this is the OWNER's own chat id; the platform already knows it. Read `ADMIN_CHAT_ID` via `ctx.env` (prefer toolkit `adminChatId` / `requireOwner`) — never ask a user, never treat whoever writes first as the admin, never invent claim-admin or open manage for everyone.
  - may be UNSET at runtime: the bot must still start, and the feature needing ADMIN_CHAT_ID must say so plainly instead of failing.

Your behavioral specs run WITHOUT these values, so no spec may depend on one.

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

An entity that merely NAMES an owner-supplied setting above (an admin chat, an API account) is not something to store or discover — read it from the environment.

- **Settings** _(retention: persistent)_ — Owner-configurable settings controlling hours, sitting length, reminder lead time, and booking rules
  - fields: timezone, opening_hours (per weekday: open, close), sitting_length_minutes, reminder_lead_hours (1,2,3,24 allowed), max_booking_lookahead_days, max_reschedule_count (optional)
- **TableInventory** _(retention: persistent)_ — Counts of tables grouped by seat capacity used to compute availability and assign tables
  - fields: table_size (e.g., 2,4,6), count
- **Booking** _(retention: persistent)_ — A single reservation record created when a guest confirms a slot
  - fields: booking_id (UUID), ref_code (6-char alphanumeric), guest_name (optional), guest_phone (optional), party_size, start_datetime (ISO, timezone-aware), end_datetime (computed from sitting_length), table_assignment (list of table sizes and ids if tracked), status (confirmed, cancelled, rescheduled, no-show), created_at, updated_at, reminder_sent_at (nullable), reschedule_count
- **Reminder** _(retention: persistent)_ — Scheduled reminders for bookings
  - fields: booking_id, scheduled_send_time, sent_at (nullable), delivery_status (sent, failed)
- **AuditEvent** _(retention: persistent)_ — Immutable log of booking lifecycle events and system actions for owner accountability
  - fields: event_id, booking_id (nullable), actor (guest|system|owner), action (create|reschedule|cancel|reminder_sent|no_show_marked|availability_refresh|setting_change), timestamp, details (freeform)
- **UserSession** _(retention: session)_ — Transient conversation state while a guest is mid-flow (party size chosen, date chosen, reserved tentative slot token)
  - fields: telegram_user_id (nullable), session_token, partial_booking_payload, expires_at

## Integrations

- **Telegram** (required) — Bot API messaging, inline keyboards, callbacks, and scheduled reminders
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Configure opening hours per weekday and timezone
- Set sitting length (minutes), reminder lead time, and max booking lookahead days
- Edit table inventory counts by size or revert to default seed inventory
- Receive immediate notifications for new bookings, cancellations, reschedules, and no-show flags
- Open compact 'today' dashboard from ADMIN_CHAT_ID and mark bookings as No-show or Cancel
- Export bookings data (owner-triggered; export format unspecified — see missing_fields)
- Seed defaults or reset settings to defaults
- Adjust allowed party-size limits and optionally disable anonymous bookings

## Notifications

- Guest confirmation message containing short ref code and actions (sent immediately on booking)
- Guest reminder at configured lead time before booking (default 2 hours)
- Guest cancellation/reschedule confirmation messages
- Owner immediate notification to ADMIN_CHAT_ID for new bookings, cancellations, and reschedules
- Owner daily summary delivered to ADMIN_CHAT_ID at configurable time with today's bookings, remaining capacity and reminder failures
- Owner notification when a reminder delivery fails or when system detects over-capacity conflicts

## Permissions & privacy

- Guest name and phone are optional and stored only for booking/contact purposes; if omitted, booking remains anonymous
- Owner (ADMIN_CHAT_ID) is the only recipient of booking notifications and daily dashboards; guest contact details are not shared beyond owner
- All personal data retention period should be configurable by owner; default retention policy should be documented to guests on first interaction
- Phone numbers are stored as plain text for contact only; no SMS sending is implemented by default (no external SMS API)
- Users can request data export via owner controls; owners must comply with local privacy laws

## Edge cases

- Simultaneous booking attempts for the same slot — must use atomic reservation/locking and return immediate feedback on failure
- Owner changes opening hours or table inventory that invalidate existing bookings — bot should surface conflicts to owner and optionally notify affected guests
- Daylight Saving Time and timezone issues — settings must include timezone to compute slot boundaries; ambiguous times must be handled safely
- Large party sizes that require multiple tables or exceed total capacity — bot should detect and refuse bookings beyond capacity with a helpful message
- Guest deletes chat or blocks bot — reminders and messages fail; failures are logged and surfaced in owner daily summary
- Guests that lose reference code — lookup flow requires ref code; no additional authentication provided unless owner requests enhancements
- Network/database outages during booking — ensure idempotent reservation attempts and clear audit events; tentative holds must expire
- Owner chat configured as a group vs private chat — owner notifications should support both but warn if group usage prevents private admin actions
- Booking edits after closing time or within a minimum lead time (owner must confirm policy)
- Phone format and validation — international formats not enforced by default; validation is permissive

## Required tests

- Dialog-level acceptance: end-to-end booking with guest skipping name and phone, obtaining valid 6-char ref code
- Availability correctness: party-size specific slot list contains only feasible slots given table inventory and overlapping bookings
- Reschedule acceptance: reschedule frees the old slot, reserves new slot atomically, and notifications sent to owner and guest
- Cancellation acceptance: cancellation frees tables and notifies owner
- Reminder delivery: scheduled reminder sent at configured lead time and marked as sent; failed delivery logged and included in daily summary
- Admin dashboard: ADMIN_CHAT_ID receives correct today's bookings list and remaining capacity
- No-show flagging: owner marks booking no-show and stats reflect it
- Concurrency stress test: multiple simultaneous booking attempts for same slot result in only allowed number of confirmations, others receive failure and refreshed availability
- Persistence across restart: bookings, settings, and audit events survive a simulated restart
- Edge: owner edits settings that conflict with bookings — bot logs conflicts and surfaces them to owner

## Assumptions

- Default opening hours (11:00–22:00) and default table inventory (4x2-seat, 4x4-seat, 2x6-seat) can be used so the bot works immediately without owner setup
- Sitting length default is 90 minutes; time slots start every 15 minutes
- Reminder default is 2 hours before booking; owner can choose 1/3/24 hours
- Reference codes are short 6-character alphanumeric and unique across active bookings
- Owner provides a single ADMIN_CHAT_ID to receive notifications and open admin dashboard; no multi-admin role handling defined
- No external calendar sync, payment, or SMS integrations are required by default
