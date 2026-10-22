import { codeUrl } from '@/lib/utils';

/** `path:line`, linked to GitHub at the cited commit when the repository is hosted there. */
export function CodeLink({ htmlUrl, r, className = 'font-mono text-xs' }: { htmlUrl: string | null | undefined; r: { filePath: string; startLine: number; endLine: number; commitSha: string }; className?: string }) {
  const label = `${r.filePath}:${r.startLine}${r.endLine !== r.startLine ? `-${r.endLine}` : ''}`;
  const href = codeUrl(htmlUrl, r);
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={`${className} text-[var(--color-accent)] hover:underline`} title={`Open on GitHub at ${r.commitSha.slice(0, 10)}`}>
      {label}
    </a>
  ) : (
    <span className={className}>{label}</span>
  );
}
