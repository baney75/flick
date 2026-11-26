// Changes stored outside signals announce themselves here: 'servers' and 'plugins'.
export const bus = new EventTarget()
export const announce = (what: 'servers' | 'plugins') => bus.dispatchEvent(new Event(what))
