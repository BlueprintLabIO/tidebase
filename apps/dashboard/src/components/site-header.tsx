import { RefreshCwIcon, ServerIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"

export function SiteHeader({
  title,
  subtitle,
  apiUrl,
  onRefresh,
}: {
  title: string
  subtitle: string
  apiUrl: string
  onRefresh: () => void
}) {
  return (
    <header className="flex min-h-(--header-height) shrink-0 items-center gap-2 border-b bg-background/80 backdrop-blur transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-3 px-4 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mx-1 data-[orientation=vertical]:h-4"
        />
        <div className="grid min-w-0 flex-1 gap-0.5 py-3">
          <h1 className="truncate text-base font-medium">{title}</h1>
          <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <div className="hidden items-center gap-2 md:flex">
          <div className="flex h-8 items-center gap-2 rounded-md border bg-card px-2.5 text-sm text-muted-foreground">
            <ServerIcon className="size-4" />
            <span>{apiUrl.replace(/^https?:\/\//, "")}</span>
          </div>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCwIcon />
            Refresh
          </Button>
        </div>
        <Button
          className="md:hidden"
          variant="outline"
          size="icon"
          onClick={onRefresh}
        >
          <RefreshCwIcon />
          <span className="sr-only">Refresh</span>
        </Button>
      </div>
    </header>
  )
}
