"use client";

import { doc } from "firebase/firestore";
import { DEFAULT_RULES, type SiteContent } from "@fsm/shared";
import { SimpleMarkdown } from "@/components/SimpleMarkdown";
import { fb } from "@/lib/firebase";
import { useDoc } from "@/lib/hooks";

export default function RulesPage() {
  const content = useDoc<SiteContent>(doc(fb().db, "content", "global"), []);
  const text = content.data?.rules ?? DEFAULT_RULES;
  return (
    <div className="stack">
      <SimpleMarkdown text={text} />
    </div>
  );
}
