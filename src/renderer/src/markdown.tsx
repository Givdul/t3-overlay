import { marked } from "marked";
import { createElement, type ReactNode } from "react";

// Markdown through marked's lexer, walked into React elements. T3's own renderer never lets page HTML
// through, and neither does this one: `html` tokens render nothing, and only http(s) links and images
// come out as elements, so a pasted `<script>` is text at worst.
//
// The lexer's tokens are read through `MdToken`, one structural view of the fields this renderer walks,
// so no branch has to assert the token's own type to reach its payload.

interface MdCell {
  tokens?: MdToken[];
  align?: "center" | "left" | "right" | null;
}

interface MdToken {
  type: string;
  raw?: string;
  text?: string;
  tokens?: MdToken[];
  depth?: number;
  ordered?: boolean;
  start?: number | "";
  items?: MdToken[];
  task?: boolean;
  checked?: boolean;
  header?: MdCell[];
  rows?: MdCell[][];
  href?: string;
  title?: string | null;
  lang?: string;
}

type LinkHandler = (url: string) => void;

const HTTP = /^https?:\/\//i;

export function Markdown({ text, onLink }: { text: string; onLink: LinkHandler }) {
  const tokens: MdToken[] = marked.lexer(text, { gfm: true });

  return <div className="t3-prose">{tokens.map((token, index) => block(token, index, onLink))}</div>;
}

function block(token: MdToken, key: number, onLink: LinkHandler): ReactNode {
  switch (token.type) {
    case "space":
    case "def":
    case "html":
      return null;
    case "paragraph":
    case "text":
      return <p key={key}>{inline(token.tokens, onLink)}</p>;
    case "heading": {
      const depth = Math.min(6, Math.max(1, token.depth ?? 1));

      return createElement(`h${depth}`, { key }, inline(token.tokens, onLink));
    }

    case "code":
      return (
        <pre key={key}>
          <code>{token.text ?? ""}</code>
        </pre>
      );
    case "blockquote":
      return <blockquote key={key}>{(token.tokens ?? []).map((child, index) => block(child, index, onLink))}</blockquote>;
    case "list": {
      const items = (token.items ?? []).map((item, index) => (
        <li key={index} className={item.task === true ? "list-none" : undefined}>
          {item.task === true && <input type="checkbox" checked={item.checked === true} readOnly className="me-2 align-middle" />}
          {(item.tokens ?? []).map((child, childIndex) => block(child, childIndex, onLink))}
        </li>
      ));

      if (token.ordered === true) {
        const start = token.start === undefined || token.start === "" ? undefined : token.start;

        return (
          <ol key={key} start={start}>
            {items}
          </ol>
        );
      }

      return <ul key={key}>{items}</ul>;
    }

    case "table":
      return (
        <div key={key} className="t3-prose-table">
          <table>
            <thead>
              <tr>
                {(token.header ?? []).map((cell, index) => (
                  <th key={index} style={{ textAlign: cell.align ?? undefined }}>
                    {inline(cell.tokens, onLink)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(token.rows ?? []).map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} style={{ textAlign: cell.align ?? undefined }}>
                      {inline(cell.tokens, onLink)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr key={key} />;
    default:
      return token.tokens === undefined ? <p key={key}>{token.text ?? token.raw ?? ""}</p> : <p key={key}>{inline(token.tokens, onLink)}</p>;
  }
}

function inline(tokens: MdToken[] | undefined, onLink: LinkHandler): ReactNode[] {
  return (tokens ?? []).map((token, index) => inlineToken(token, index, onLink));
}

function inlineToken(token: MdToken, key: number, onLink: LinkHandler): ReactNode {
  switch (token.type) {
    case "text":
      return token.tokens === undefined ? <span key={key}>{token.text ?? ""}</span> : <span key={key}>{inline(token.tokens, onLink)}</span>;
    case "escape":
      return <span key={key}>{token.text ?? ""}</span>;
    case "codespan":
      return <code key={key}>{token.text ?? ""}</code>;
    case "strong":
      return <strong key={key}>{inline(token.tokens, onLink)}</strong>;
    case "em":
      return <em key={key}>{inline(token.tokens, onLink)}</em>;
    case "del":
      return <del key={key}>{inline(token.tokens, onLink)}</del>;
    case "br":
      return <br key={key} />;
    case "link": {
      const href = token.href ?? "";

      if (!HTTP.test(href)) {
        // A workspace file mention: T3 draws it as a chip, so the sent message reads the same here.
        return (
          <span key={key} className="mention-chip" title={href}>
            {fileLabel(href, token.text ?? "")}
          </span>
        );
      }

      return (
        <a
          key={key}
          href={href}
          title={token.title ?? undefined}
          onClick={(event) => {
            event.preventDefault();
            onLink(href);
          }}
        >
          {inline(token.tokens, onLink)}
        </a>
      );
    }

    case "image": {
      const href = token.href ?? "";

      return HTTP.test(href) ? (
        <img key={key} src={href} alt={token.text ?? ""} title={token.title ?? undefined} loading="lazy" />
      ) : (
        <span key={key}>{token.text ?? ""}</span>
      );
    }

    case "html":
      return null;
    default:
      return token.tokens === undefined ? <span key={key}>{token.text ?? token.raw ?? ""}</span> : <span key={key}>{inline(token.tokens, onLink)}</span>;
  }
}

/** The basename of a mentioned path, decoded from the mention's percent-encoded markdown link. */
function fileLabel(href: string, fallback: string): string {
  let path = href;

  try {
    path = decodeURIComponent(href);
  } catch {
    // A malformed escape is just part of the name.
  }

  return path.split(/[\\/]/).pop() || fallback || path;
}
