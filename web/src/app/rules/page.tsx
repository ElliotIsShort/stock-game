"use client";

import { doc } from "firebase/firestore";
import { DEFAULT_RULES, type SiteContent } from "@fsm/shared";
import { SimpleMarkdown } from "@/components/SimpleMarkdown";
import { usePaths } from "@/components/GameProvider";
import { fb } from "@/lib/firebase";
import { useDoc } from "@/lib/hooks";

export default function RulesPage() {
  const paths = usePaths();
  const content = useDoc<SiteContent>(doc(fb().db, paths.content), []);
  // A new server starts with an empty rules doc: show the defaults until the admin writes their own.
  const text = content.data?.rules?.trim() ? content.data.rules : DEFAULT_RULES;
  return (
    <div className="stack">
      <SimpleMarkdown text={text} />
    </div>
  );
}
