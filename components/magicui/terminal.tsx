"use client"

import {
  Children,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { ArrowDownToLine, Check, Copy, SquareTerminal, WrapText } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface SequenceContextValue {
  completeItem: (index: number) => void
  activeIndex: number
  sequenceStarted: boolean
}

const SequenceContext = createContext<SequenceContextValue | null>(null)
const useSequence = () => useContext(SequenceContext)
const ItemIndexContext = createContext<number | null>(null)
const useItemIndex = () => useContext(ItemIndexContext)

function useInView(ref: React.RefObject<Element>, options?: IntersectionObserverInit & { once?: boolean }) {
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setInView(true)
        if (options?.once) observer.disconnect()
      } else if (!options?.once) {
        setInView(false)
      }
    }, { threshold: options?.threshold ?? 0.3 })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, options?.once, options?.threshold])
  return inView
}

interface AnimatedSpanProps {
  children: React.ReactNode
  delay?: number
  className?: string
  startOnView?: boolean
}

export const AnimatedSpan = ({
  children,
  delay = 0,
  className,
  startOnView = false,
}: AnimatedSpanProps) => {
  const elementRef = useRef<HTMLDivElement>(null)
  const isInView = useInView(elementRef as React.RefObject<Element>, { threshold: 0.3, once: true })

  const sequence = useSequence()
  const itemIndex = useItemIndex()
  const [hasStarted, setHasStarted] = useState(false)

  useEffect(() => {
    if (!sequence || itemIndex === null || !sequence.sequenceStarted || hasStarted) return
    if (sequence.activeIndex === itemIndex) setHasStarted(true)
  }, [sequence, hasStarted, itemIndex])

  const shouldAnimate = sequence ? hasStarted : startOnView ? isInView : true

  return (
    <div
      ref={elementRef}
      className={cn(
        "grid text-sm font-normal tracking-tight transition-[opacity,transform] duration-300",
        shouldAnimate
          ? "opacity-100 translate-y-0"
          : "opacity-0 -translate-y-1 pointer-events-none",
        className
      )}
      style={{ transitionDelay: sequence ? "0ms" : `${delay}ms` }}
      onTransitionEnd={() => {
        if (!sequence || itemIndex === null || !shouldAnimate) return
        sequence.completeItem(itemIndex)
      }}
    >
      {children}
    </div>
  )
}

type MotionElementType = "article" | "div" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "p" | "section" | "span"

interface TypingAnimationProps {
  children: string
  className?: string
  duration?: number
  delay?: number
  as?: MotionElementType
  startOnView?: boolean
}

export const TypingAnimation = ({
  children,
  className,
  duration = 60,
  delay = 0,
  as: Component = "span",
  startOnView = true,
}: TypingAnimationProps) => {
  if (typeof children !== "string") {
    throw new Error("TypingAnimation: children must be a string.")
  }

  const [displayedText, setDisplayedText] = useState<string>("")
  const [started, setStarted] = useState(false)
  const elementRef = useRef<HTMLElement>(null)
  const isInView = useInView(elementRef as React.RefObject<Element>, { threshold: 0.3, once: true })

  const sequence = useSequence()
  const itemIndex = useItemIndex()
  const hasSequence = sequence !== null
  const sequenceStarted = sequence?.sequenceStarted ?? false
  const sequenceActiveIndex = sequence?.activeIndex ?? null
  const sequenceCompleteItemRef = useRef<SequenceContextValue["completeItem"] | null>(null)
  const sequenceItemIndexRef = useRef<number | null>(null)

  useEffect(() => {
    sequenceCompleteItemRef.current = sequence?.completeItem ?? null
    sequenceItemIndexRef.current = itemIndex
  }, [sequence?.completeItem, itemIndex])

  useEffect(() => {
    let startTimeout: ReturnType<typeof setTimeout> | null = null
    if (hasSequence && itemIndex !== null) {
      if (sequenceStarted && !started && sequenceActiveIndex === itemIndex) setStarted(true)
    } else if (!startOnView || isInView) {
      startTimeout = setTimeout(() => setStarted(true), delay)
    }
    return () => { if (startTimeout !== null) clearTimeout(startTimeout) }
  }, [delay, startOnView, isInView, started, hasSequence, sequenceActiveIndex, sequenceStarted, itemIndex])

  useEffect(() => {
    if (!started) return
    let i = 0
    const typingEffect = setInterval(() => {
      if (i < children.length) {
        setDisplayedText(children.substring(0, i + 1))
        i++
      } else {
        clearInterval(typingEffect)
        const completeItem = sequenceCompleteItemRef.current
        const currentItemIndex = sequenceItemIndexRef.current
        if (completeItem && currentItemIndex !== null) completeItem(currentItemIndex)
      }
    }, duration)
    return () => clearInterval(typingEffect)
  }, [children, duration, started])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const El = Component as any
  return (
    <El
      ref={elementRef}
      className={cn("text-sm font-normal tracking-tight", className)}
    >
      {displayedText}
    </El>
  )
}

// TerminalWindow renders just the terminal chrome (window frame + optional
// title + toolbar) around a scrollable body. Unlike `Terminal`, it does no
// sequencing/typing — use it to wrap live, streaming content (e.g. real-time
// build logs). It owns auto-scroll: it follows new output until the user
// scrolls up, then shows a "Latest" button to resume.
//
// The surface is dark in BOTH themes, using local terminal tokens (--t-*) that
// children can use too, e.g. `text-[var(--t-err)]`.
interface TerminalWindowProps {
  children: React.ReactNode
  title?: React.ReactNode
  className?: string
  bodyClassName?: string
  bodyRef?: React.Ref<HTMLDivElement>
}

export const TerminalWindow = ({
  children,
  title,
  className,
  bodyClassName,
  bodyRef,
}: TerminalWindowProps) => {
  const innerRef = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)
  const [following, setFollowing] = useState(true)
  const [wrap, setWrap] = useState(true)
  const [copied, setCopied] = useState(false)

  const setRefs = useCallback((el: HTMLDivElement | null) => {
    innerRef.current = el
    if (typeof bodyRef === "function") bodyRef(el)
    else if (bodyRef) (bodyRef as React.MutableRefObject<HTMLDivElement | null>).current = el
  }, [bodyRef])

  const scrollToEnd = () => {
    const el = innerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // Follow new output while locked to the bottom.
  useEffect(() => {
    if (stick.current) scrollToEnd()
  })

  const onScroll = () => {
    const el = innerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    stick.current = atBottom
    setFollowing(prev => (prev === atBottom ? prev : atBottom))
  }

  const resume = () => {
    stick.current = true
    setFollowing(true)
    scrollToEnd()
  }

  const copy = async () => {
    const text = innerRef.current?.innerText ?? ""
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard unavailable */ }
  }

  const toolBtn =
    "h-7 gap-1 px-2 text-xs text-[var(--t-muted)] hover:bg-[var(--t-hover)] hover:text-[var(--t-fg)] aria-pressed:bg-[var(--t-hover)] aria-pressed:text-[var(--t-fg)]"

  return (
    <div
      className={cn(
        "relative flex flex-col overflow-hidden rounded-xl border border-[var(--t-border)] bg-[var(--t-bg)] text-[var(--t-fg)]",
        "[--t-bg:#0d1117] [--t-bar:#161b22] [--t-border:#30363d] [--t-hover:#21262d]",
        "[--t-fg:#e6edf3] [--t-muted:#8b949e] [--t-dim:#7d8590] [--t-err:#ff7b72] [--t-sys:#d2a8ff] [--t-ok:#7ee787] [--t-warn:#e3b341]",
        className
      )}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--t-border)] bg-[var(--t-bar)] px-3 py-1.5">
        <SquareTerminal className="size-4 shrink-0 text-[var(--t-muted)]" aria-hidden />
        {title && (
          <div className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--t-muted)]">{title}</div>
        )}
        {!title && <div className="flex-1" />}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-pressed={wrap}
          aria-label="Wrap long lines"
          title="Wrap long lines"
          className={toolBtn}
          onClick={() => setWrap(w => !w)}
        >
          <WrapText className="size-3.5" />
          <span className="hidden sm:inline">Wrap</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label="Copy log"
          title="Copy log"
          className={toolBtn}
          onClick={copy}
        >
          {copied ? <Check className="size-3.5 text-[var(--t-ok)]" /> : <Copy className="size-3.5" />}
          <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
      <div
        ref={setRefs}
        onScroll={onScroll}
        role="log"
        aria-live="off"
        tabIndex={0}
        aria-label={typeof title === "string" ? title : "Log output"}
        className={cn(
          "min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--t-muted)]",
          wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
          bodyClassName
        )}
      >
        {children}
      </div>
      {!following && (
        <Button
          type="button"
          size="xs"
          onClick={resume}
          className="absolute right-4 bottom-4 gap-1 bg-[var(--t-fg)] text-[var(--t-bg)] shadow-pop hover:bg-[var(--t-fg)]/90"
        >
          <ArrowDownToLine className="size-3.5" />
          Latest
        </Button>
      )}
    </div>
  )
}

interface TerminalProps {
  children: React.ReactNode
  className?: string
  sequence?: boolean
  startOnView?: boolean
}

export const Terminal = ({
  children,
  className,
  sequence = true,
  startOnView = true,
}: TerminalProps) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const isInView = useInView(containerRef as React.RefObject<Element>, { threshold: 0.3, once: true })

  const [activeIndex, setActiveIndex] = useState(0)
  const sequenceHasStarted = sequence ? !startOnView || isInView : false

  const contextValue = useMemo<SequenceContextValue | null>(() => {
    if (!sequence) return null
    return {
      completeItem: (index: number) => {
        setActiveIndex((current) => (index === current ? current + 1 : current))
      },
      activeIndex,
      sequenceStarted: sequenceHasStarted,
    }
  }, [sequence, activeIndex, sequenceHasStarted])

  const wrappedChildren = useMemo(() => {
    if (!sequence) return children
    return Children.toArray(children).map((child, index) => (
      <ItemIndexContext.Provider key={index} value={index}>
        {child as React.ReactNode}
      </ItemIndexContext.Provider>
    ))
  }, [children, sequence])

  const content = (
    <div
      ref={containerRef}
      className={cn(
        "border-border bg-background z-0 h-full max-h-100 w-full max-w-lg rounded-xl border",
        className
      )}
    >
      <div className="border-border flex flex-col gap-y-2 border-b p-4">
        <div className="flex flex-row gap-x-2">
          <div className="h-2 w-2 rounded-full bg-red-500" />
          <div className="h-2 w-2 rounded-full bg-yellow-500" />
          <div className="h-2 w-2 rounded-full bg-green-500" />
        </div>
      </div>
      <pre className="p-4">
        <code className="grid gap-y-1 overflow-auto">{wrappedChildren}</code>
      </pre>
    </div>
  )

  if (!sequence) return content

  return (
    <SequenceContext.Provider value={contextValue}>
      {content}
    </SequenceContext.Provider>
  )
}
