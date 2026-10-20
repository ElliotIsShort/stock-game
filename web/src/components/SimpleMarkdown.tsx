"use client";

import type { ReactNode } from "react";

/**
 * Tiny, safe renderer for the Rules and Change log text. Supports:
 * # / ## headings, "- " bullet lists, and blank-line-separated paragraphs.
 * Plain text only — no HTML is interpreted, so admin-entered content is safe.
 */
export function SimpleMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let key = 0;

  const flushList = () => {
    if (list.length) {
      blocks.push(
        <ul key={key++}>
          {list.map((item, i) => <li key={i}>{item}</li>)}
        </ul>,
      );
      list = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("## ")) {
      flushList();
      blocks.push(<h2 key={key++}>{line.slice(3)}</h2>);
    } else if (line.startsWith("# ")) {
      flushList();
      blocks.push(<h1 key={key++}>{line.slice(2)}</h1>);
    } else if (line.startsWith("- ")) {
      list.push(line.slice(2));
    } else if (line.trim() === "") {
      flushList();
    } else {
      flushList();
      blocks.push(<p key={key++}>{line}</p>);
    }
  }
  flushList();
  return <div className="prose">{blocks}</div>;
}
