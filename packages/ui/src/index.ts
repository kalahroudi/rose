// SPDX-License-Identifier: Apache-2.0
// @rose/ui: the shell, page template and interaction kit shared by the admin console and
// the tenant app. Build pages from these parts so every screen behaves the same way.
export { api, ApiError, errorMessage, type ApiOptions, type Page as PageData } from "./api";
export { Icon, Logo, type IconName } from "./icons";
export { Badge, Button, Callout, CodeBlock, Copy, CopyChip, EmptyState, ExternalLink, formatNumber, Hint, IconButton, Time, timeAgo, type Tone } from "./primitives";
export { Drawer, PreviewDrawer, UiProvider, useConfirm, useToast, type DrawerProps } from "./overlay";
export { Advanced, Field, FormDrawer, Input, Select, Textarea, type FormApi } from "./form";
export { DataTable, useListState, type Column, type DataTableProps, type ListState, type Selection } from "./table";
export { Gate, jobLabel, jobTone, Page, Shell, Skeleton, Splash, ThemeToggle, useTab, type HelpContent, type JobView, type NavItem, type PageProps, type ShellProps, type TabDef } from "./page";
export { BarChart, Flow, IsolationDiagram, Kpi, type FlowStep } from "./viz";
export { addPasskey, AuthLayout, createInvalidator, createQueryClient, SecurityPanel, SignIn, type SignInProps } from "./auth";
