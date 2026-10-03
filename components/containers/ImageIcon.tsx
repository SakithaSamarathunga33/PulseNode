"use client"

import {
  Docker, PostgreSQL, MySQL, MariaDB, Redis, MongoDB,
  ClickHouse, Elastic, NodeJs, Python,
  NestJS, NuxtJs, NextJs,
} from "developer-icons"

type DeveloperIcon = React.ComponentType<React.SVGProps<SVGSVGElement> & { size?: number }>

const IMAGE_ICONS: Array<[RegExp, DeveloperIcon]> = [
  [/postgres/i,   PostgreSQL],
  [/mysql/i,      MySQL],
  [/mariadb/i,    MariaDB],
  [/redis/i,      Redis],
  [/mongo/i,      MongoDB],
  [/clickhouse/i, ClickHouse],
  [/elastic/i,    Elastic],
  [/node/i,       NodeJs],
  [/python/i,     Python],
  [/nestjs/i,     NestJS],
  [/nuxt/i,       NuxtJs],
  [/next/i,       NextJs],
]

/** Tech logo for an image reference (Docker whale as the fallback). */
export function ImageIcon({ image }: { image: string }) {
  for (const [re, Icon] of IMAGE_ICONS) {
    if (re.test(image)) return <Icon size={16} className="shrink-0" />
  }
  return <Docker size={16} className="shrink-0" />
}

