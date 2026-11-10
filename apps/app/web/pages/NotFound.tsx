// SPDX-License-Identifier: Apache-2.0
import { EmptyState, Page } from "@rose/ui";
import { Link } from "wouter";
import { terms } from "../help/glossary";

export function NotFoundPage() {
  return (
    <Page
      title="Page not found"
      description="This address does not match any page in the workspace."
      help={{ what: "The link you followed does not lead anywhere, or it leads to a page your role can not open. Pages you lack permission for are hidden from the menu.", terms: terms("role") }}
    >
      <div className="card">
        <EmptyState icon="search" title="Nothing here" action={<Link href="/" className="btn btn-primary">Go to Overview</Link>}>
          The page may have moved, or your role may not include it. Ask a workspace admin if you expected to see something.
        </EmptyState>
      </div>
    </Page>
  );
}
