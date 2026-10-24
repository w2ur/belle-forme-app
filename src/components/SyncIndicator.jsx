const iconClass = "w-5 h-5 transition-colors duration-300";

function CloudCheck() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
      <path d="M9 16l2 2 4-4"/>
    </svg>
  );
}

function CloudSync() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={`${iconClass} animate-pulse`}>
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
    </svg>
  );
}

function CloudError() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
      <path d="M15 13l-6 6M9 13l6 6"/>
    </svg>
  );
}

function CloudOff() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 1 0 0-10z" strokeDasharray="4 2"/>
      <path d="M2 2l20 20"/>
    </svg>
  );
}

const STATUS_CONFIG = {
  idle: { icon: null, color: "" },
  syncing: { icon: CloudSync, color: "text-muted" },
  synced: { icon: CloudCheck, color: "text-accent" },
  error: { icon: CloudError, color: "text-danger" },
  offline: { icon: CloudOff, color: "text-muted-dark" },
};

/**
 * The cloud icon, plus — with `stacked`, for the 88px side rail — the outbox
 * counts laid out under it. The compact header has no room beside the title,
 * so it renders the icon alone and puts `SyncCounts` on a line of its own.
 */
export default function SyncIndicator({ status, stacked = false, ...counts }) {
  const config = STATUS_CONFIG[status];
  const Icon = config?.icon;
  if (!stacked) return Icon ? <StatusIcon status={status} config={config} Icon={Icon} /> : null;

  return (
    <div className="flex flex-col items-center gap-1 text-center">
      {Icon && <StatusIcon status={status} config={config} Icon={Icon} />}
      <SyncCounts {...counts} stacked />
    </div>
  );
}

/**
 * The outbox, when it holds anything: « 2 en attente » for writes not yet
 * confirmed by Neon, and « 1 envoi refusé · Réessayer » for writes the server
 * refused, which are kept but never retried on their own. There is
 * deliberately no way to discard a write from here.
 */
export function SyncCounts({ pendingCount = 0, parkedCount = 0, onRetryParked, retrying = false, stacked = false }) {
  if (pendingCount === 0 && parkedCount === 0) return null;
  return (
    <div className={`flex text-[12px] leading-tight ${stacked ? "flex-col items-center gap-1" : "flex-wrap items-center gap-x-3 gap-y-1"}`}>
      {pendingCount > 0 && <span className="text-muted">{pendingCount} en attente</span>}
      {parkedCount > 0 && (
        <span className={`flex items-center text-danger ${stacked ? "flex-col gap-0.5" : "gap-1"}`}>
          <span>{parkedCount} {parkedCount > 1 ? "envois refusés" : "envoi refusé"}</span>
          {!stacked && <span aria-hidden="true">·</span>}
          <button
            type="button"
            onClick={onRetryParked}
            disabled={retrying}
            className="-my-2 cursor-pointer border-none bg-transparent px-1 py-2 text-[12px] font-semibold text-danger underline disabled:cursor-wait disabled:opacity-50"
          >
            Réessayer
          </button>
        </span>
      )}
    </div>
  );
}

function StatusIcon({ status, config, Icon }) {
  return (
    <div className={`${config.color} flex items-center`} title={
      status === "syncing" ? "Synchronisation..." :
      status === "synced" ? "Synchronise" :
      status === "error" ? "Erreur de synchronisation" :
      status === "offline" ? "Hors ligne" : ""
    }>
      <Icon />
    </div>
  );
}
