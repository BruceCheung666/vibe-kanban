import { cn } from '@/lib/utils';

export type ActorInfo = {
  id: string;
  name?: string | null;
  role?: string | null;
  kind?: string | null;
};

interface ChatActorBadgeProps {
  actor: ActorInfo;
  className?: string;
}

export function ChatActorBadge({ actor, className }: ChatActorBadgeProps) {
  const label = actor.name ?? actor.role ?? actor.id;
  const kind = actor.kind?.toUpperCase() ?? 'AGENT';

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-2 py-0.5',
        'text-[10px] font-medium uppercase tracking-wide text-low border-border',
        className
      )}
    >
      <span>{kind}</span>
      <span className="text-high normal-case">{label}</span>
    </div>
  );
}
