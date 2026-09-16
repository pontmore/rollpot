"use client";

import { Box, Typography } from "@mui/material";

const pipPositions: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

export function DiceFace({ label, value, size = 132 }: { label: string; value: number | null; size?: number }) {
  const pips = value ? pipPositions[value] : [];
  const compact = size < 132;
  const pending = value === null;

  return (
    <Box sx={{ textAlign: "center" }}>
      <Box
        aria-label={pending ? `${label} has not rolled` : `${label} rolled ${value}`}
        sx={{
          position: "relative",
          width: size,
          height: size,
          mx: "auto",
          borderRadius: 2,
          bgcolor: pending ? "transparent" : "#f8f2e8",
          border: pending ? "2px dashed rgba(255,255,255,0.35)" : "2px solid rgba(255,255,255,0.5)",
          boxShadow: pending ? "none" : compact ? "0 8px 16px rgba(0,0,0,0.18)" : "0 22px 42px rgba(0,0,0,0.28)",
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gridTemplateRows: "repeat(3, 1fr)",
          p: compact ? 1 : 2,
          gap: compact ? 0.5 : 1,
        }}
      >
        {Array.from({ length: 9 }).map((_, index) => (
          <Box
            key={index}
            sx={{
              width: compact ? Math.round(size / 6) : 22,
              height: compact ? Math.round(size / 6) : 22,
              borderRadius: "50%",
              placeSelf: "center",
              bgcolor: pips.includes(index) ? "#17251b" : "transparent",
            }}
          />
        ))}
        {pending ? <Typography aria-hidden="true" sx={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", color: "text.secondary", fontSize: size / 2, fontWeight: 700 }}>?</Typography> : null}
      </Box>
      <Typography variant={compact ? "caption" : "subtitle2"} sx={{ mt: compact ? 0.5 : 1, fontWeight: 900, color: pending ? "text.secondary" : "text.primary" }}>
        {label}
      </Typography>
    </Box>
  );
}
