import * as THREE from 'three'
import type { UseStore } from 'zustand'
import type { Instance } from './renderer'
import type { RootState } from './store'

export interface Intersection extends THREE.Intersection {
  eventObject: THREE.Object3D
}

export interface IntesectionEvent<TSourceEvent> extends Intersection {
  intersections: Intersection[]
  stopped: boolean
  unprojectedPoint: THREE.Vector3
  ray: THREE.Ray
  camera: Camera
  stopPropagation: () => void
  sourceEvent: TSourceEvent
  delta: number
}

export type Camera = THREE.OrthographicCamera | THREE.PerspectiveCamera
export type ThreeEvent<TEvent> = TEvent & IntesectionEvent<TEvent>
export type DomEvent = ThreeEvent<PointerEvent | MouseEvent | WheelEvent>

export type Events = {
  onClick: EventListener
  onContextMenu: EventListener
  onDoubleClick: EventListener
  onWheel: EventListener
  onPointerDown: EventListener
  onPointerUp: EventListener
  onPointerLeave: EventListener
  onPointerMove: EventListener
  onPointerCancel: EventListener
  onLostPointerCapture: EventListener
}

export type EventHandlers = {
  onClick?: (event: ThreeEvent<MouseEvent>) => void
  onContextMenu?: (event: ThreeEvent<MouseEvent>) => void
  onDoubleClick?: (event: ThreeEvent<MouseEvent>) => void
  onPointerUp?: (event: ThreeEvent<PointerEvent>) => void
  onPointerDown?: (event: ThreeEvent<PointerEvent>) => void
  onPointerOver?: (event: ThreeEvent<PointerEvent>) => void
  onPointerOut?: (event: ThreeEvent<PointerEvent>) => void
  onPointerEnter?: (event: ThreeEvent<PointerEvent>) => void
  onPointerLeave?: (event: ThreeEvent<PointerEvent>) => void
  onPointerMove?: (event: ThreeEvent<PointerEvent>) => void
  onPointerMissed?: (event: ThreeEvent<PointerEvent>) => void
  onPointerCancel?: (event: ThreeEvent<PointerEvent>) => void
  onWheel?: (event: ThreeEvent<WheelEvent>) => void
}

export interface EventManager<TTarget> {
  connected: TTarget | boolean
  handlers?: Events
  connect?: (target: TTarget) => void
  disconnect?: () => void
}

export function createEvents(store: UseStore<RootState>) {
  const hovered = new Map<string, DomEvent>()
  const temp = new THREE.Vector3()

  /** Sets up defaultRaycaster */
  function prepareRay(event: DomEvent) {
    const state = store.getState()
    const { raycaster, mouse, camera, size } = state
    // https://github.com/pmndrs/react-three-fiber/pull/782
    // Events trigger outside of canvas when moved
    const { offsetX, offsetY } = raycaster.computeOffsets?.(event, state) ?? event
    const { width, height } = size
    mouse.set((offsetX / width) * 2 - 1, -(offsetY / height) * 2 + 1)
    raycaster.setFromCamera(mouse, camera)
  }

  /** Calculates delta */
  function calculateDistance(event: DomEvent) {
    const { internal } = store.getState()
    const dx = event.offsetX - internal.initialClick[0]
    const dy = event.offsetY - internal.initialClick[1]
    return Math.round(Math.sqrt(dx * dx + dy * dy))
  }

  /** Returns true if an instance has a valid pointer-event registered, this excludes scroll, clicks etc */
  function filterPointerEvents(objects: THREE.Object3D[]) {
    return objects.filter((obj) =>
      ['Move', 'Over', 'Enter', 'Out', 'Leave'].some(
        (name) => ((obj as unknown) as Instance).__r3f.handlers?.[('onPointer' + name) as keyof EventHandlers],
      ),
    )
  }

  function makeId(event: Intersection) {
    return (event.eventObject || event.object).uuid + '/' + event.index
  }

  function intersect(filter?: (objects: THREE.Object3D[]) => THREE.Object3D[]) {
    const state = store.getState()
    const { raycaster, internal } = state
    // Skip event handling when noEvents is set
    if (!raycaster.enabled) return []

    const seen = new Set<string>()
    const intersections: Intersection[] = []

    // Allow callers to eliminate event objects
    const eventsObjects = filter ? filter(internal.interaction) : internal.interaction

    // Intersect known handler objects and filter against duplicates
    let intersects = raycaster.intersectObjects(eventsObjects, true).filter((item) => {
      const id = makeId(item as Intersection)
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })

    // https://github.com/mrdoob/three.js/issues/16031
    // Allow custom userland intersect sort order
    if (raycaster.filter) intersects = raycaster.filter(intersects, state)

    for (const intersect of intersects) {
      let eventObject: THREE.Object3D | null = intersect.object
      // Bubble event up
      while (eventObject) {
        const handlers = ((eventObject as unknown) as Instance).__r3f?.handlers
        if (handlers) intersections.push({ ...intersect, eventObject })
        eventObject = eventObject.parent
      }
    }
    return intersections
  }

  /**  Creates filtered intersects and returns an array of positive hits */
  function patchIntersects(intersections: Intersection[], event: DomEvent) {
    const { internal } = store.getState()
    // If the interaction is captured take that into account, the captured event has to be part of the intersects
    if (internal.captured && event.type !== 'click' && event.type !== 'wheel') {
      internal.captured.forEach((captured) => {
        if (!intersections.find((hit) => hit.eventObject === captured.eventObject)) intersections.push(captured)
      })
    }
    return intersections
  }

  /**  Handles intersections by forwarding them to handlers */
  function handleIntersects(intersections: Intersection[], event: DomEvent, callback: (event: DomEvent) => void) {
    const { raycaster, mouse, camera, internal } = store.getState()
    // If anything has been found, forward it to the event listeners
    if (intersections.length) {
      const unprojectedPoint = temp.set(mouse.x, mouse.y, 0).unproject(camera)
      const delta = event.type === 'click' ? calculateDistance(event) : 0
      const releasePointerCapture = (id: number) => (event.target as Element).releasePointerCapture(id)
      const localState = { stopped: false, captured: false }

      for (const hit of intersections) {
        const setPointerCapture = (id: number) => {
          // If the hit is going to be captured flag that we're in captured state
          if (!localState.captured) {
            localState.captured = true
            // The captured hit array is reset to collect hits
            internal.captured = []
          }
          // Push hits to the array
          if (internal.captured)
            internal.captured.push(hit)
            // Call the original event now
          ;(event.target as Element).setPointerCapture(id)
        }

        // Add native event props
        let extractEventProps: any = {}
        for (let prop in Object.getPrototypeOf(event)) {
          extractEventProps[prop] = event[prop as keyof DomEvent]
        }

        let raycastEvent: any = {
          ...hit,
          ...extractEventProps,
          intersections,
          stopped: localState.stopped,
          delta,
          unprojectedPoint,
          ray: raycaster.ray,
          camera: camera,
          // Hijack stopPropagation, which just sets a flag
          stopPropagation: () => {
            // https://github.com/pmndrs/react-three-fiber/issues/596
            // Events are not allowed to stop propagation if the pointer has been captured
            const cap = internal.captured
            if (!cap || cap.find((h) => h.eventObject.id === hit.eventObject.id)) {
              raycastEvent.stopped = localState.stopped = true

              // Propagation is stopped, remove all other hover records
              // An event handler is only allowed to flush other handlers if it is hovered itself
              if (hovered.size && Array.from(hovered.values()).find((i) => i.eventObject === hit.eventObject)) {
                // Objects cannot flush out higher up objects that have already caught the event
                const higher = intersections.slice(0, intersections.indexOf(hit))
                cancelPointer([...higher, hit])
              }
            }
          },
          target: { ...event.target, setPointerCapture, releasePointerCapture },
          currentTarget: { ...event.currentTarget, setPointerCapture, releasePointerCapture },
          sourceEvent: event,
        }

        // Call subscribers
        callback(raycastEvent as DomEvent)
        // Event bubbling may be interrupted by stopPropagation
        if (localState.stopped === true) break
      }
    }
    return intersections
  }

  function cancelPointer(hits: Intersection[]) {
    Array.from(hovered.values()).forEach((hoveredObj) => {
      // When no objects were hit or the the hovered object wasn't found underneath the cursor
      // we call onPointerOut and delete the object from the hovered-elements map
      if (!hits.length || !hits.find((hit) => hit.object === hoveredObj.object && hit.index === hoveredObj.index)) {
        const eventObject = hoveredObj.eventObject
        const handlers = ((eventObject as unknown) as Instance).__r3f.handlers
        hovered.delete(makeId(hoveredObj))
        if (handlers) {
          // Clear out intersects, they are outdated by now
          const data = { ...hoveredObj, intersections: hits || [] }
          handlers.onPointerOut?.(data as ThreeEvent<PointerEvent>)
          handlers.onPointerLeave?.(data as ThreeEvent<PointerEvent>)
        }
      }
    })
  }

  const handlePointer = (name: string) => {
    // Deal with cancelation
    switch (name) {
      case 'onPointerLeave':
      case 'onPointerCancel':
        return () => cancelPointer([])
      case 'onLostPointerCapture':
        return () => ((store.getState().internal.captured = undefined), cancelPointer([]))
    }

    // Any other pointer goes here ...
    return (event: DomEvent) => {
      const { onPointerMissed, internal } = store.getState()

      prepareRay(event)

      // Get fresh intersects
      const isPointerMove = name === 'onPointerMove'
      const filter = isPointerMove ? filterPointerEvents : undefined
      const hits = patchIntersects(intersect(filter), event)

      // Take care of unhover
      if (isPointerMove) cancelPointer(hits)

      handleIntersects(hits, event, (data: DomEvent) => {
        const eventObject = data.eventObject
        const handlers = ((eventObject as unknown) as Instance).__r3f.handlers
        // Check presence of handlers
        if (!handlers) return

        if (isPointerMove) {
          // Move event ...
          if (handlers.onPointerOver || handlers.onPointerEnter || handlers.onPointerOut || handlers.onPointerLeave) {
            // When enter or out is present take care of hover-state
            const id = makeId(data)
            const hoveredItem = hovered.get(id)
            if (!hoveredItem) {
              // If the object wasn't previously hovered, book it and call its handler
              hovered.set(id, data)
              handlers.onPointerOver?.(data as ThreeEvent<PointerEvent>)
              handlers.onPointerEnter?.(data as ThreeEvent<PointerEvent>)
            } else if (hoveredItem.stopped) {
              // If the object was previously hovered and stopped, we shouldn't allow other items to proceed
              data.stopPropagation()
            }
          }
          // Call mouse move
          handlers.onPointerMove?.(data as ThreeEvent<PointerEvent>)
        } else {
          // All other events ...
          const handler = handlers?.[name as keyof EventHandlers] as (event: ThreeEvent<PointerEvent>) => void
          if (handler) {
            // Forward all events back to their respective handlers with the exception of click events,
            // which must use the initial target
            if (
              (name !== 'onClick' && name !== 'onContextMenu' && name !== 'onDoubleClick') ||
              internal.initialHits.includes(eventObject)
            ) {
              handler(data as ThreeEvent<PointerEvent>)
              pointerMissed(
                event,
                internal.interaction.filter((object) => object !== eventObject),
              )
            }
          }
        }
      })

      // Save initial coordinates on pointer-down
      if (name === 'onPointerDown') {
        internal.initialClick = [event.offsetX, event.offsetY]
        internal.initialHits = hits.map((hit) => hit.eventObject)
      }

      // If a click yields no results, pass it back to the user as a miss
      if ((name === 'onClick' || name === 'onContextMenu' || name === 'onDoubleClick') && !hits.length) {
        if (calculateDistance(event) <= 2) {
          pointerMissed(event, internal.interaction)
          if (onPointerMissed) onPointerMissed()
        }
      }
    }
  }

  function pointerMissed(event: MouseEvent, objects: THREE.Object3D[]) {
    objects.forEach((object: THREE.Object3D) =>
      ((object as unknown) as Instance).__r3f.handlers?.onPointerMissed?.(event as ThreeEvent<PointerEvent>),
    )
  }

  return { handlePointer }
}
