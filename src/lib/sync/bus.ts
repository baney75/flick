// Changes stored outside signals announce themselves here: 'servers', 'addons' and 'plugins'.
export const bus = new EventTarget()
export const announce = (what: 'servers' | 'addons' | 'plugins') => bus.dispatchEvent(new Event(what))
