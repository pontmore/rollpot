import { Alert, Box, Button, Container, Link, Stack, Typography } from "@mui/material";
import { RollpotClient } from "../components/rollpot-client";
import { DESCRIPTOR_URL } from "../lib/escrow";
import { discoverEscrowService } from "../lib/escrow-server";

export default async function Home() {
  try {
    const service = await discoverEscrowService(DESCRIPTOR_URL);

    return <RollpotClient initialService={service} />;
  } catch (error) {
    return (
      <Box component="main" sx={{ minHeight: "100vh", py: 8 }}>
        <Container maxWidth="md">
          <Stack spacing={3}>
            <Typography component="h1" variant="h3" sx={{ fontWeight: 900 }}>
              Rollpot
            </Typography>
            <Alert severity="error">
              {error instanceof Error ? error.message : "Unable to load escrow descriptor."}
            </Alert>
            <Button component={Link} href={DESCRIPTOR_URL} variant="outlined">
              Open descriptor
            </Button>
          </Stack>
        </Container>
      </Box>
    );
  }
}
