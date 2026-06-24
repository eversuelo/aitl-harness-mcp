import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Render markdown the way GitHub does: a `prose` block tuned to the GitHub-dark
 * palette (links, code, tables, blockquotes, headings with subtle rules).
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        "prose prose-invert max-w-none",
        "prose-headings:scroll-mt-20 prose-headings:font-semibold",
        "prose-h1:text-2xl prose-h1:border-b prose-h1:border-border prose-h1:pb-2",
        "prose-h2:text-xl prose-h2:border-b prose-h2:border-border prose-h2:pb-1.5 prose-h2:mt-8",
        "prose-h3:text-base",
        "prose-a:text-primary prose-a:no-underline hover:prose-a:underline",
        "prose-code:rounded prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:font-normal prose-code:before:content-[''] prose-code:after:content-['']",
        "prose-pre:bg-muted prose-pre:border prose-pre:border-border prose-pre:text-foreground",
        "prose-blockquote:border-l-border prose-blockquote:text-muted-foreground prose-blockquote:not-italic",
        "prose-table:text-sm prose-th:border prose-th:border-border prose-th:bg-muted prose-th:px-3 prose-th:py-1.5 prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-1.5",
        "prose-li:my-0.5 prose-hr:border-border",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
