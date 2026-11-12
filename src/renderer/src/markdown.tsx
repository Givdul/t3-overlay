import { marked } from "marked";
import { createElement, type ReactNode } from "react";
import { refractor } from "refractor/core";
import bash from "refractor/bash";
import css from "refractor/css";
import diff from "refractor/diff";
import go from "refractor/go";
import javascript from "refractor/javascript";
import json from "refractor/json";
import jsx from "refractor/jsx";
import markdown from "refractor/markdown";
import markup from "refractor/markup";
import python from "refractor/python";
import rust from "refractor/rust";
import sql from "refractor/sql";
import tsx from "refractor/tsx";
import typescript from "refractor/typescript";
import yaml from "refractor/yaml";

// Markdown through marked's lexer, walked into React elements. T3's own renderer never lets page HTML
// through, and neither does this one: `html` tokens render as the text they are, and only http(s) links
// and images come out as elements, so a pasted `<script>` is text at worst.
//
// Fenced code is coloured by refractor: its grammars answer HAST spans, which `hast()` walks into React
// nodes, so no code ever becomes innerHTML. A fence whose language is not registered stays plain.
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

// The grammars the panel carries: the languages chat messages actually use. They cost about 37 KB of
// the renderer's gzip, so the set is the knob to turn if that ever matters.
for (const syntax of [bash, css, diff, go, javascript, json, jsx, markdown, markup, python, rust, sql, tsx, typescript, yaml]) {
  refractor.register(syntax);
}

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

export function Markdown({ text, onLink }: { text: string; onLink: LinkHandler }) {
  const tokens: MdToken[] = marked.lexer(text, { gfm: true });

  return <div className="t3-prose">{tokens.map((token, index) => block(token, index, onLink))}</div>;
}

function block(token: MdToken, key: number, onLink: LinkHandler): ReactNode {
  switch (token.type) {
    case "space":
    case "def":
      return null;
    case "html":
      // Literal HTML is shown, never run: the panel draws messages, it does not host pages.
      return (
        <p key={key} className="whitespace-pre-wrap">
          {token.raw ?? ""}
        </p>
      );
    case "paragraph":
    case "text":
      return <p key={key}>{inline(token.tokens, onLink)}</p>;
    case "heading": {
      const depth = Math.min(6, Math.max(1, token.depth ?? 1));

      return createElement(`h${depth}`, { key }, inline(token.tokens, onLink));
    }

    case "code": {
      const language = fenceLanguage(token.lang);
      const text = token.text ?? "";

      return (
        <pre key={key}>
          <code>{language === null ? text : refractor.highlight(text, language).children.map((node, index) => hast(node, index))}</code>
        </pre>
      );
    }

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
      return <span key={key}>{token.raw ?? ""}</span>;
    default:
      return token.tokens === undefined ? <span key={key}>{token.text ?? token.raw ?? ""}</span> : <span key={key}>{inline(token.tokens, onLink)}</span>;
  }
}

/** The fence's language when a grammar is registered for it; ```` ```ts title=x ```` names `ts`. */
function fenceLanguage(lang: string | undefined): string | null {
  const name = (lang ?? "").trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";

  return name !== "" && refractor.registered(name) ? name : null;
}

/** One refractor node: token spans with their class names, and the code's own text. */
function hast(node: HastNode, key: number): ReactNode {
  if (node.type === "text") return node.value ?? "";

  if (node.type !== "element") return null;

  const className = Array.isArray(node.properties?.className) ? node.properties.className.join(" ") : undefined;

  return createElement(
    node.tagName ?? "span",
    { key, className },
    (node.children ?? []).map((child, index) => hast(child, index)),
  );
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
