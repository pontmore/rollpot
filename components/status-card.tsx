"use client";

import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import RefreshIcon from "@mui/icons-material/Refresh";
import { Box, Button, Stack, Tooltip, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { isOwnPaymentConfirmed, type FundStatusResponse, type FundingInstructionsResponse } from "../lib/escrow";

export function FundingStatusCard({
  title,
  disabled,
  instructions,
  status,
  onInstructions,
  onStatus,
}: {
  title: string;
  disabled: boolean;
  instructions: FundingInstructionsResponse | null;
  status: FundStatusResponse | null;
  onInstructions: () => void;
  onStatus: () => void;
}) {
  const [qrDataUrl, setQrDataUrl] = useState("");
  const paid = isOwnPaymentConfirmed(status);

  useEffect(() => {
    if (!instructions?.payment_request) {
      setQrDataUrl("");
      return;
    }

    let cancelled = false;

    QRCode.toString(instructions.payment_request, {
      type: "svg",
      width: 360,
      margin: 4,
      color: { dark: "#000000", light: "#ffffff" },
    }).then((svg) => {
      if (!cancelled) setQrDataUrl(`data:image/svg+xml,${encodeURIComponent(svg)}`);
    }).catch(() => {
      // Silently skip QR generation on failure.
    });

    return () => { cancelled = true; };
  }, [instructions?.payment_request]);

  return (
    <Box>
      <Stack spacing={1.5}>
        <Typography variant="subtitle1" sx={{ fontWeight: 900 }}>
          {title}
        </Typography>
        {!instructions && !paid ? <Button disabled={disabled} onClick={onInstructions} variant="contained" size="small" sx={{ alignSelf: "flex-start" }}>
          Get invoice
        </Button> : null}
        {instructions && !paid ? (
          <Stack spacing={1.2}>
            {qrDataUrl ? (
              <Box sx={{ width: 360, maxWidth: "100%", mx: { xs: "auto", md: 0 }, p: 1.5, bgcolor: "#fff", border: "2px solid #d7e2d6", borderRadius: 2, boxShadow: "0 4px 20px rgba(0, 0, 0, 0.2)" }}>
                <Box
                  component="img"
                  src={qrDataUrl}
                  alt="Lightning invoice QR code"
                  sx={{ display: "block", width: "100%", height: "auto" }}
                />
              </Box>
            ) : null}
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<ContentCopyIcon />}
                onClick={() => navigator.clipboard.writeText(instructions.payment_request)}
              >
                Copy invoice
              </Button>
              {!paid ? <Button disabled={disabled} onClick={onStatus} variant="text" size="small" startIcon={<RefreshIcon />}>
                Check payment
              </Button> : null}
            </Stack>
          </Stack>
        ) : null}
        {status ? <Typography variant="body2" color={paid ? "success.main" : "text.secondary"} aria-live="polite">
          {[
            paid ? "Your payment received" : instructions ? "Waiting for your payment" : "",
            status.funded_count != null ? `${status.funded_count} of ${status.funding_threshold || status.total_funders || "?"} payments received` : "",
          ].filter(Boolean).join(" · ")}
        </Typography> : null}
      </Stack>
    </Box>
  );
}

export function KeyValue({ label, value, copy = false }: { label: string; value: string; copy?: boolean }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 900, textTransform: "uppercase" }}>
        {label}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Typography variant="body2" sx={{ overflowWrap: "anywhere", minWidth: 0 }}>
          {value}
        </Typography>
        {copy ? (
          <Tooltip title="Copy">
            <Button size="small" variant="text" onClick={() => navigator.clipboard.writeText(value)} sx={{ minWidth: 36 }}>
              <ContentCopyIcon fontSize="small" />
            </Button>
          </Tooltip>
        ) : null}
      </Stack>
    </Box>
  );
}
