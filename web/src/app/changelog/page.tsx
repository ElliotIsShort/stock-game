"use client";

import { doc } from "firebase/firestore";
import { DEFAULT_CHANGELOG, type SiteContent } from "@fsm/shared";
import { SimpleMarkdown } from "@/components/SimpleMarkdown";
import { fb } from "@/lib/firebase";
import { useDoc } from "@/lib/hooks";

export default function ChangelogPage() {
  const content = useDoc<SiteContent>(doc(fb().db, "content", "global"), []);
  const text = content.data?.changelog ?? DEFAULT_CHANGELOG;
  return (
    <div className="stack">
      <SimpleMarkdown text={text} />
    </div>
  );
}
