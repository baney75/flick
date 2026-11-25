// Changes stored outside signals announce themselves here: 'servers' and 'addons'.
export const bus = new EventTarget()
export const announce = (what: 'servers' | 'addons') => bus.dispatchEvent(new Event(what))
