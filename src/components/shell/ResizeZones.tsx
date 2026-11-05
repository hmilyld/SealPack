import type { CSSProperties } from "react";

import { startResize, type ResizeDirection } from "@/api";

const ZONES: { dir: ResizeDirection; style: CSSProperties }[] = [
  { dir: "North", style: { top: 0, left: 8, right: 8, height: 4, cursor: "ns-resize" } },
  { dir: "South", style: { bottom: 0, left: 8, right: 8, height: 4, cursor: "ns-resize" } },
  { dir: "West", style: { left: 0, top: 8, bottom: 8, width: 4, cursor: "ew-resize" } },
  { dir: "East", style: { right: 0, top: 8, bottom: 8, width: 4, cursor: "ew-resize" } },
  {
    dir: "NorthWest",
    style: { top: 0, left: 0, width: 10, height: 10, cursor: "nwse-resize" },
  },
  {
    dir: "NorthEast",
    style: { top: 0, right: 0, width: 10, height: 10, cursor: "nesw-resize" },
  },
  {
    dir: "SouthWest",
    style: { bottom: 0, left: 0, width: 10, height: 10, cursor: "nesw-resize" },
  },
  {
    dir: "SouthEast",
    style: { bottom: 0, right: 0, width: 10, height: 10, cursor: "nwse-resize" },
  },
];

/** 无边框窗口的四边四角缩放热区。 */
export function ResizeZones() {
  return (
    <>
      {ZONES.map((zone) => (
        <div
          key={zone.dir}
          className="resize-zone"
          style={zone.style}
          onMouseDown={() => void startResize(zone.dir).catch(() => {})}
        />
      ))}
    </>
  );
}
