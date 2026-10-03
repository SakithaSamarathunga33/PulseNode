"use client"

import {
  Children,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

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

// TerminalWindow renders just the macOS terminal chrome (window frame +
// traffic-light dots + optional title) around a scrollable body. Unlike
// `Terminal`, it does no sequencing/typing — use it to wrap live, streaming
// content (e.g. real-time build logs) while keeping the terminal look.
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
}: TerminalWindowProps) => (
  <div
    className={cn("flex flex-col overflow-hidden rounded-xl border", className)}
    style={{ borderColor: "var(--border)", background: "#0d1117" }}
  >
    <div
      className="flex shrink-0 items-center gap-2 px-4 py-3"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <div className="flex flex-row gap-x-2">
        <div className="h-3 w-3 rounded-full bg-red-500" />
        <div className="h-3 w-3 rounded-full bg-yellow-500" />
        <div className="h-3 w-3 rounded-full bg-green-500" />
      </div>
      {title && (
        <div
          className="ml-2 truncate font-mono text-xs"
          style={{ color: "var(--fg-4)" }}
        >
          {title}
        </div>
      )}
    </div>
    <div
      ref={bodyRef}
      className={cn(
        "flex-1 overflow-y-auto p-4 font-mono text-xs leading-5",
        bodyClassName
      )}
    >
      {children}
    </div>
  </div>
)

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
