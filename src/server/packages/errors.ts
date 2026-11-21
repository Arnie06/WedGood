/** Maps database errors from package RPCs to messages safe to show. */
export function friendlyPackageError(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case "42501":
      return "Packages can only be created by the workspace owner or a partner.";
    case "28000":
      return "Please sign in again to continue.";
    case "55000":
      return "Your plan changed while this was being prepared. Reload to review the updated preview.";
    case "54000":
      return "You've created a lot of packages recently. Wait a little before making another.";
    case "23505":
      return "This package was already created. Open it from your package list.";
    case "22023":
      return "Please check the package details and try again.";
    default:
      return "We couldn't create this package. Nothing was saved. Try again.";
  }
}
