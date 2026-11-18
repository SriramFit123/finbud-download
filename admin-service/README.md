# FinBud APK Admin Service

This small Node.js service serves the password-protected admin page and securely replaces the APK attached to the existing `v1.0.0` GitHub release. The GitHub token and admin password are read only from server environment variables; neither is placed in the browser code or repository.

## Required private environment values

- `ADMIN_PASSWORD`: choose a strong password for the fixed username `FinBud Admin`.
- `GITHUB_TOKEN`: a fine-grained token limited to `SriramFit123/finbud-download` with **Contents: Read and write** permission.

The service streams uploaded APKs to temporary storage, uploads a staging asset to GitHub, then swaps the names. It removes the previous release asset after the new APK is live, and attempts to restore the old name if the swap fails.

## Render deployment

The repository root contains a Render Blueprint (`render.yaml`) for the free web-service plan. During the one-time service setup, provide the two private values above in Render's secret fields. The free instance may sleep while unused; its first request after sleeping can take about a minute to wake.

