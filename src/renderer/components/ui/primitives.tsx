import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px] tracking-wide uppercase",
  {
    variants: {
      variant: {
        default: "border bg-secondary text-secondary-foreground",
        success: "border bg-success/10 text-success",
        warning: "border bg-warning/10 text-warning",
        destructive: "border bg-destructive/10 text-destructive",
        brand: "border bg-primary/10 text-brand",
        ink: "border bg-ink text-ink-foreground",
        outline: "border bg-card text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  }
)

function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      className={cn(
        "h-9 w-full rounded-md border border-input bg-card px-3 font-mono text-sm text-foreground",
        "outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring",
        "disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label data-slot="label" className={cn("text-sm font-medium text-foreground", className)} {...props} />
}

function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "h-9 w-full rounded-md border border-input bg-card px-2 text-sm text-foreground",
        "outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-20 w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs text-foreground",
        "outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring",
        className
      )}
      {...props}
    />
  )
}

export { Badge, badgeVariants, Input, Label, Select, Textarea }
