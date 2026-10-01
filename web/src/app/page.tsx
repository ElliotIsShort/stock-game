"use client";

import { Feed } from "@/components/Feed";
import { PostComposer } from "@/components/PostComposer";
import { useGame } from "@/components/GameProvider";
import { gbp } from "@/lib/format";

export default function FeedPage() {
  const { state } = useGame();
  return (
    <div className="stack">
      <div className="row between">
        <h1>Feed</h1>
        {state && <span className="pill">Prize pool {gbp(state.prizePool)}</span>}
      </div>
      <PostComposer />
      <Feed />
    </div>
  );
}
