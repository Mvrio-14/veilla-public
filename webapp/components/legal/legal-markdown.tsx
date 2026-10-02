import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders a legal document from markdown with restrained typography,
 * suited to long-form legal prose. The component overrides the default
 * HTML tags so the theme tokens apply.
 */
export function LegalMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => (
          <h1 className="font-display text-[clamp(28px,3.5vw,40px)] font-medium tracking-tight leading-[1.15] text-text mb-6">
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className="text-[20px] font-semibold tracking-tight text-text mt-12 mb-4">
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className="text-[16px] font-semibold tracking-tight text-text mt-8 mb-3">
            {children}
          </h3>
        ),
        p: ({ children }) => (
          <p className="text-[14.5px] leading-[1.65] text-text-2 my-4">
            {children}
          </p>
        ),
        ul: ({ children }) => (
          <ul className="list-disc pl-5 my-4 space-y-1.5 text-[14.5px] leading-[1.65] text-text-2">
            {children}
          </ul>
        ),
        li: ({ children }) => <li className="pl-1">{children}</li>,
        a: ({ children, href }) => (
          <a
            href={href}
            className="text-text underline underline-offset-2 decoration-text-3 hover:decoration-text transition-colors"
          >
            {children}
          </a>
        ),
        strong: ({ children }) => (
          <strong className="font-semibold text-text">{children}</strong>
        ),
        hr: () => <hr className="my-10 border-border" />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
