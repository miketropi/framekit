/**
 * Minimal stand-in for the parts of `remotion` the example module uses.
 *
 * The example targets a Remotion project; this package does not install Remotion or
 * React. Aliasing the module here lets the test execute the example's pure logic and
 * confirm the module graph, without adding a renderer dependency.
 */
import type React from "react";

export const AbsoluteFill: React.FC<React.PropsWithChildren<{ style?: unknown }>> = () => null;
export const Sequence: React.FC<
  React.PropsWithChildren<{ from?: number; durationInFrames?: number }>
> = () => null;
export const Img: React.FC<{ src: string }> = () => null;
export const Video: React.FC<{ src: string }> = () => null;

export function staticFile(relativePath: string): string {
  return `/${relativePath}`;
}

export function useVideoConfig(): { fps: number; width: number; height: number } {
  return { fps: 30, width: 2048, height: 1152 };
}
