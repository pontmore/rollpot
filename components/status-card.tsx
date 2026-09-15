"use client";

import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import RefreshIcon from "@mui/icons-material/Refresh";
import { Box, Button, Chip, Stack, Tooltip, Typography } from "@mui/material";
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

    QRCode.toDataURL(instructions.payment_request, {
      width: 220,
      margin: 1,
      color: { dark: "#17251b", light: "#f8f2e8" },
    }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
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
              <Box sx={{ textAlign: "center" }}>
                <Box
                  component="img"
                  src={qrDataUrl}
                  alt="Lightning invoice QR code"
                  sx={{ width: 200, height: 200, borderRadius: 1 }}
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
        {status ? (
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            <Chip size="small" label={paid ? "Your payment confirmed" : "Waiting for your payment"} color={paid ? "success" : "default"} />
            {status.funded_count != null ? <Chip size="small" label={`${status.funded_count}/${status.funding_threshold || status.total_funders || "?"} funded`} /> : null}
          </Stack>
        ) : null}
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
