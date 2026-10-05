/**
 * Remotion consumption example.
 *
 * Generated footage already exists on disk before rendering: this module only reads
 * local files through Remotion's `staticFile`. It performs no network access, no
 * generation, and imports no provider SDK — Remotion renders deterministically from
 * assets that were created earlier by `hf video`.
 */
import { AbsoluteFill, Img, Sequence, Video, staticFile } from "remotion";
import type React from "react";

export type ShotStatus =
  "planned" | "needs_asset" | "generating" | "generated" | "approved" | "rejected";

export interface Shot {
  id: string;
  duration: number;
  source: {
    type: "generated-image" | "generated-video";
    /** Path relative to the Remotion static directory, e.g. "assets/shot-003/video.mp4". */
    asset: string | null;
    manifest?: string | null;
  };
  creative?: { subjectAction?: string; camera?: string };
  status: ShotStatus;
}

export interface ShotList {
  project: string;
  shots: Shot[];
}

/** Approved shots only: the default gate for a final composition. */
export function approvedShots(list: ShotList): Shot[] {
  return list.shots.filter((shot) => shot.status === "approved" && shot.source.asset !== null);
}

const ShotScene: React.FC<{ shot: Shot }> = ({ shot }) => {
  const asset = shot.source.asset;
  if (asset === null) return null;

  return (
    <AbsoluteFill>
      {shot.source.type === "generated-video" ? (
        <Video src={staticFile(asset)} />
      ) : (
        <Img src={staticFile(asset)} />
      )}
    </AbsoluteFill>
  );
};

export const DemoLaunchFilm: React.FC<{
  shots: Shot[];
  fps?: number;
  width?: number;
  height?: number;
}> = ({ shots, fps = 30, width = 2048, height = 1152 }) => (
  <AbsoluteFill style={{ backgroundColor: "black", width, height }}>
    {(() => {
      let from = 0;
      return shots.map((shot) => {
        const durationInFrames = Math.max(1, Math.round(shot.duration * fps));
        const sequence = (
          <Sequence key={shot.id} from={from} durationInFrames={durationInFrames}>
            <ShotScene shot={shot} />
          </Sequence>
        );
        from += durationInFrames;
        return sequence;
      });
    })()}
  </AbsoluteFill>
);
