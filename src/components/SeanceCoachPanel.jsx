import CoachConversation from "./CoachConversation.jsx";

/**
 * The same coach, docked beside the séance. `chat` comes from App.jsx, so this
 * panel and the Coach tab render ONE conversation object rather than two hook
 * instances that drift apart — she has one coach, and one server-side
 * transcript (`coach_messages`).
 *
 * Hidden below `xl` (1280px) by its own classes: portrait iPad gets it as a
 * sheet in a follow-up, because the séance itself must not be cramped.
 *
 * No toggle, no plan button: you do not rebuild a week mid-workout. `mode` is
 * shared hook state though (one `useCoachChat` for both surfaces), so a plain
 * `chat.send()` here would carry whatever mode she last left the Coach tab's
 * toggle on. This panel must never touch shared state to route around that —
 * `chat.setMode` also persists to `localStorage`
 * (`useCoachChat.js:MODE_KEY`), specifically so her choice survives
 * backgrounding, and this panel mounts whenever a séance screen is open
 * REGARDLESS of viewport (`App.jsx:160,172`) — including on a phone, where it
 * is invisible (`hidden xl:flex` below) but its effects would not be. Calling
 * `chat.setMode("discussion")` here would silently overwrite a preference she
 * never asked to change, the moment she starts a workout. Instead it uses
 * `chat.sendDiscussion`, which is fixed to the "discussion" wire mode without
 * ever reading or writing `chat.mode`.
 */
export default function SeanceCoachPanel({ chat, catalog = null }) {
  if (!chat.hasClient) return null;

  return (
    <aside className="hidden xl:flex w-[380px] shrink-0 flex-col border-l border-border pl-5"
           aria-label="Coach">
      <h3 className="mb-2 font-serif text-sm font-semibold uppercase tracking-wide text-muted">Coach</h3>
      <CoachConversation
        catalog={catalog}
        compact
        messages={chat.messages}
        streaming={chat.streaming}
        streamingMode={chat.streamingMode}
        busy={chat.busy}
        draft={chat.draft}
        setDraft={chat.setDraft}
        onSend={chat.sendDiscussion}
        /* `onImport` is deliberately NOT passed, and passing a no-op instead was
           the bug. `Bubble` renders « Importer ce programme » whenever it has a
           payload, and a no-op arrow function is truthy — so the button was
           live-looking and wired to nothing on this surface. Scrolling back to
           last week's programme mid-séance gave her a full card with a button
           that produced no card, no notice and no error: from the iPad,
           indistinguishable from a broken app. Omitting the prop leaves it
           `undefined`, which is what `Bubble` gates the button on; the card
           itself still renders, so the programme stays readable mid-workout. Do
           NOT "fix" this by wiring a real handler here — importing a week
           mid-séance is not something this surface should do. */
        error={chat.error}
        onDismissError={chat.dismissError}
        onReload={chat.reload}
      />
    </aside>
  );
}
