import * as React from "react";
import { useId } from "react";
import { useTranslation } from "./i18n.tsx";
import "./proxy-resources.css";

const RESOURCES = [
  {
    name: "Mihomo", kind: "Desktop client documentation",
    description: "Configure local HTTP, SOCKS or mixed ports for a desktop proxy client.",
    topic: "Local proxy ports", url: "https://wiki.metacubex.one/en/config/inbound/port/",
  },
  {
    name: "Bright Data", kind: "Provider documentation",
    description: "Understand residential, ISP and datacenter networks, with session and location controls.",
    topic: "Proxy infrastructure", url: "https://docs.brightdata.com/left-over/proxy-networks-introduction",
  },
  {
    name: "Oxylabs", kind: "Provider documentation",
    description: "Check which HTTP, HTTPS and SOCKS5 protocols each proxy product supports.",
    topic: "Supported protocols", url: "https://developers.oxylabs.io/help-center/products-and-features/supported-protocols",
  },
  {
    name: "Decodo", kind: "Provider documentation",
    description: "Compare sticky and rotating residential proxy sessions before setting up your endpoint.",
    topic: "Session types", url: "https://help.decodo.com/docs/residential-proxy-session-types",
  },
] as const;

/** Documentation references only. Rendering this component makes no remote requests. */
export function ProxyResources() {
  const { t } = useTranslation();
  const headingId = useId();
  return <section className="proxy-resources" aria-labelledby={headingId}>
    <div className="proxy-resources-heading">
      <div><span className="proxy-resources-eyebrow">{t("Official documentation")}</span><h3 id={headingId}>{t("Proxy resources")}</h3></div>
      <p>{t("Explore connection options, protocols and session settings from their original sources.")}</p>
    </div>
    <div className="proxy-resource-grid">{RESOURCES.map(resource => <a
      key={resource.name} className="proxy-resource-card" href={resource.url} target="_blank" rel="noopener noreferrer"
      aria-label={t("Read {name} documentation (opens in a new tab)", { name: resource.name })}
    >
      <div className="proxy-resource-card-top"><span className="proxy-resource-kind">{t(resource.kind)}</span><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M11 4h5v5M16 4l-8 8M8 4H5a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1v-3" strokeLinecap="round" strokeLinejoin="round" /></svg></div>
      <h4>{resource.name}</h4><p>{t(resource.description)}</p>
      <span className="proxy-resource-topic">{t(resource.topic)}<span aria-hidden="true"> →</span></span>
    </a>)}</div>
  </section>;
}
