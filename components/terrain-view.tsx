'use client';

import { useEffect, useRef, useState } from 'react';
import type * as ThreeTypes from 'three/webgpu';

export type TerrainStats = {
  fps: number;
  triangles: number;
  loadedTiles: number;
  totalTiles: number;
  gamepad: string | null;
  renderer: 'INITIALIZING' | 'WEBGPU' | 'UNAVAILABLE';
};

type Center = { latitude: number; longitude: number };

type TerrainViewProps = {
  center: Center;
  exaggeration: number;
  highDetail: boolean;
  wireframe: boolean;
  resetSignal: number;
  onStats: (stats: TerrainStats) => void;
};

type TileData = {
  x: number;
  y: number;
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
};

const ZOOM = 11;
const TILE_RADIUS = 1;
const TILE_COUNT = (TILE_RADIUS * 2 + 1) ** 2;
const EARTH_RADIUS = 6_378_137;
const BASE_ELEVATION = 1_850;
const TILE_ENDPOINT =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const COLOR_STOPS = [
  { h: 1_400, hex: '#17372f' },
  { h: 2_100, hex: '#34553e' },
  { h: 3_000, hex: '#74724d' },
  { h: 4_000, hex: '#8b765d' },
  { h: 4_900, hex: '#9ca0a0' },
  { h: 6_200, hex: '#e4e9e5' },
];
const tileCache = new Map<string, Promise<TileData>>();

function lonLatToTile(lon: number, lat: number, zoom: number) {
  const scale = 2 ** zoom;
  return {
    x: ((lon + 180) / 360) * scale,
    y:
      ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) *
      scale,
  };
}

function decodeElevation(pixels: Uint8ClampedArray, index: number) {
  const offset = index * 4;
  return (
    pixels[offset] * 256 +
    pixels[offset + 1] +
    pixels[offset + 2] / 256 -
    32_768
  );
}

function heightColor(
  elevation: number,
  target: ThreeTypes.Color,
  stops: Array<{ h: number; c: ThreeTypes.Color }>,
) {
  for (let i = 0; i < stops.length - 1; i += 1) {
    const lower = stops[i];
    const upper = stops[i + 1];
    if (elevation <= upper.h) {
      const amount = Math.max(
        0,
        Math.min(1, (elevation - lower.h) / (upper.h - lower.h)),
      );
      return target.lerpColors(lower.c, upper.c, amount);
    }
  }

  return target.copy(stops[stops.length - 1].c);
}

async function loadTile(x: number, y: number): Promise<TileData> {
  const key = `${ZOOM}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) return cached;

  const task = loadTileUncached(x, y).catch((error) => {
    tileCache.delete(key);
    throw error;
  });
  tileCache.set(key, task);
  return task;
}

async function loadTileUncached(x: number, y: number): Promise<TileData> {
  const url = TILE_ENDPOINT.replace('{z}', `${ZOOM}`)
    .replace('{x}', `${x}`)
    .replace('{y}', `${y}`);
  const response = await fetch(url, { mode: 'cors' });
  if (!response.ok) throw new Error(`Terrain tile ${x}/${y} failed`);

  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Unable to decode terrain tile');
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { x, y, pixels: image.data, width: image.width, height: image.height };
}

function refineAxis(value: number, deadzone = 0.12) {
  if (Math.abs(value) <= deadzone) return 0;
  const normalized = (Math.abs(value) - deadzone) / (1 - deadzone);
  return Math.sign(value) * normalized * Math.sqrt(normalized);
}

export function TerrainView({
  center,
  exaggeration,
  highDetail,
  wireframe,
  resetSignal,
  onStats,
}: TerrainViewProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const terrainRef = useRef<ThreeTypes.Group | null>(null);
  const materialRef = useRef<ThreeTypes.MeshStandardMaterial | null>(null);
  const resetRef = useRef<(() => void) | null>(null);
  const exaggerationRef = useRef(exaggeration);
  const wireframeRef = useRef(wireframe);
  const statsRef = useRef<TerrainStats>({
    fps: 0,
    triangles: 0,
    loadedTiles: 0,
    totalTiles: TILE_COUNT,
    gamepad: null,
    renderer: 'INITIALIZING',
  });
  const [issue, setIssue] = useState<string | null>(null);
  const [loading, setLoading] = useState('PREPARING WEBGPU');

  useEffect(() => {
    exaggerationRef.current = exaggeration;
    terrainRef.current?.scale.set(1, exaggeration, 1);
  }, [exaggeration]);

  useEffect(() => {
    wireframeRef.current = wireframe;
    if (materialRef.current) {
      materialRef.current.wireframe = wireframe;
      materialRef.current.needsUpdate = true;
    }
  }, [wireframe]);

  useEffect(() => {
    if (resetSignal > 0) resetRef.current?.();
  }, [resetSignal]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const chrome =
      /Chrome\//.test(navigator.userAgent) &&
      !/(Edg|OPR)\//.test(navigator.userAgent);
    const hasWebGPU = 'gpu' in navigator;

    if (!chrome || !hasWebGPU) {
      statsRef.current.renderer = 'UNAVAILABLE';
      onStats({ ...statsRef.current });
      queueMicrotask(() => {
        setIssue(
          chrome
            ? '当前 Chrome 未启用 WebGPU。请升级浏览器并确认硬件加速已开启。'
            : '此地形实验仅支持桌面版 Google Chrome。',
        );
      });
      return;
    }

    let disposed = false;
    let frameHandle = 0;
    let resizeObserver: ResizeObserver | null = null;
    const cleanupListeners: Array<() => void> = [];

    async function initialize() {
      try {
        const THREE = await import('three/webgpu');
        if (disposed || !mountRef.current) return;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#081011');
        scene.fog = new THREE.FogExp2('#101c1d', 0.000035);

        const camera = new THREE.PerspectiveCamera(48, 1, 10, 120_000);
        const renderer = new THREE.WebGPURenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 0.92;
        await renderer.init();

        if (disposed) {
          renderer.dispose();
          return;
        }

        renderer.domElement.className = 'terrain-canvas';
        renderer.domElement.setAttribute('aria-label', '吉隆口岸三维地形');
        renderer.domElement.setAttribute('role', 'img');
        mountRef.current.appendChild(renderer.domElement);

        scene.add(new THREE.HemisphereLight('#b8d9d0', '#171f1d', 1.5));
        const sun = new THREE.DirectionalLight('#ffe7bf', 3.4);
        sun.position.set(-18_000, 24_000, -12_000);
        scene.add(sun);

        const terrain = new THREE.Group();
        terrain.scale.set(1, exaggerationRef.current, 1);
        terrainRef.current = terrain;
        scene.add(terrain);

        const material = new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.93,
          metalness: 0.02,
          wireframe: wireframeRef.current,
        });
        materialRef.current = material;

        const centerTile = lonLatToTile(
          center.longitude,
          center.latitude,
          ZOOM,
        );
        const tileMeterSize =
          (Math.cos((center.latitude * Math.PI) / 180) *
            2 *
            Math.PI *
            EARTH_RADIUS) /
          2 ** ZOOM;
        const tileX = Math.floor(centerTile.x);
        const tileY = Math.floor(centerTile.y);
        const coordinates: Array<{ x: number; y: number }> = [];

        for (let row = -TILE_RADIUS; row <= TILE_RADIUS; row += 1) {
          for (let column = -TILE_RADIUS; column <= TILE_RADIUS; column += 1) {
            coordinates.push({ x: tileX + column, y: tileY + row });
          }
        }

        let loadedTiles = 0;
        let portElevation = BASE_ELEVATION;
        const segments = highDetail ? 128 : 64;
        const tempColor = new THREE.Color();
        const colorStops = COLOR_STOPS.map(({ h, hex }) => ({
          h,
          c: new THREE.Color(hex),
        }));

        for (let start = 0; start < coordinates.length; start += 3) {
          const batch = coordinates.slice(start, start + 3);
          const tiles = await Promise.all(
            batch.map(async ({ x, y }) => {
              try {
                return await loadTile(x, y);
              } catch (error) {
                console.warn(error);
                return null;
              }
            }),
          );
          if (disposed) return;

          for (const tile of tiles) {
            if (!tile) continue;
            const vertexCount = (segments + 1) ** 2;
            const positions = new Float32Array(vertexCount * 3);
            const colors = new Float32Array(vertexCount * 3);
            const indices = new Uint32Array(segments * segments * 6);

            for (let row = 0; row <= segments; row += 1) {
              for (let column = 0; column <= segments; column += 1) {
                const u = column / segments;
                const v = row / segments;
                const pixelX = Math.min(
                  tile.width - 1,
                  Math.round(u * (tile.width - 1)),
                );
                const pixelY = Math.min(
                  tile.height - 1,
                  Math.round(v * (tile.height - 1)),
                );
                const elevation = decodeElevation(
                  tile.pixels,
                  pixelY * tile.width + pixelX,
                );
                const vertex = row * (segments + 1) + column;
                const offset = vertex * 3;
                positions[offset] =
                  (tile.x + u - centerTile.x) * tileMeterSize;
                positions[offset + 1] = elevation - BASE_ELEVATION;
                positions[offset + 2] =
                  (tile.y + v - centerTile.y) * tileMeterSize;

                heightColor(elevation, tempColor, colorStops);
                colors[offset] = tempColor.r;
                colors[offset + 1] = tempColor.g;
                colors[offset + 2] = tempColor.b;

                if (
                  tile.x === tileX &&
                  tile.y === tileY &&
                  Math.abs(u - (centerTile.x - tileX)) < 1 / segments &&
                  Math.abs(v - (centerTile.y - tileY)) < 1 / segments
                ) {
                  portElevation = elevation;
                }
              }
            }

            let cursor = 0;
            for (let row = 0; row < segments; row += 1) {
              for (let column = 0; column < segments; column += 1) {
                const a = row * (segments + 1) + column;
                const b = a + 1;
                const c = a + segments + 1;
                const d = c + 1;
                indices[cursor++] = a;
                indices[cursor++] = c;
                indices[cursor++] = b;
                indices[cursor++] = b;
                indices[cursor++] = c;
                indices[cursor++] = d;
              }
            }

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute(
              'position',
              new THREE.BufferAttribute(positions, 3),
            );
            geometry.setAttribute(
              'color',
              new THREE.BufferAttribute(colors, 3),
            );
            geometry.setIndex(new THREE.BufferAttribute(indices, 1));
            geometry.computeVertexNormals();
            geometry.computeBoundingSphere();

            terrain.add(new THREE.Mesh(geometry, material));
            loadedTiles += 1;
            statsRef.current.loadedTiles = loadedTiles;
            statsRef.current.triangles = loadedTiles * segments * segments * 2;
            onStats({ ...statsRef.current });
            setLoading(`LOADING TERRAIN  ${loadedTiles} / ${TILE_COUNT}`);
          }
        }

        if (loadedTiles === 0) {
          throw new Error('无法读取高程瓦片，请检查网络后重试。');
        }

        const marker = new THREE.Group();
        marker.position.set(0, portElevation - BASE_ELEVATION + 100, 0);
        const pinMaterial = new THREE.MeshBasicMaterial({ color: '#ff6f4e' });
        const mast = new THREE.Mesh(
          new THREE.CylinderGeometry(11, 11, 240, 12),
          pinMaterial,
        );
        mast.position.y = 120;
        marker.add(mast);
        const point = new THREE.Mesh(
          new THREE.SphereGeometry(44, 20, 12),
          pinMaterial,
        );
        point.position.y = 255;
        marker.add(point);
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(150, 5, 8, 64),
          new THREE.MeshBasicMaterial({
            color: '#ffc09c',
            transparent: true,
            opacity: 0.8,
          }),
        );
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 8;
        marker.add(ring);
        terrain.add(marker);

        const view = {
          yaw: -0.78,
          pitch: 0.42,
          distance: 20_500,
          target: new THREE.Vector3(0, 1_100, 0),
        };

        const resetView = () => {
          view.yaw = -0.78;
          view.pitch = 0.42;
          view.distance = 20_500;
          view.target.set(0, 1_100, 0);
        };
        resetRef.current = resetView;

        const keys = new Set<string>();
        let dragging = false;
        let lastX = 0;
        let lastY = 0;

        const onPointerDown = (event: PointerEvent) => {
          dragging = true;
          lastX = event.clientX;
          lastY = event.clientY;
          renderer.domElement.setPointerCapture(event.pointerId);
        };
        const onPointerMove = (event: PointerEvent) => {
          if (!dragging) return;
          view.yaw -= (event.clientX - lastX) * 0.0045;
          view.pitch = Math.max(
            0.08,
            Math.min(1.28, view.pitch + (event.clientY - lastY) * 0.004),
          );
          lastX = event.clientX;
          lastY = event.clientY;
        };
        const onPointerUp = () => {
          dragging = false;
        };
        const onWheel = (event: WheelEvent) => {
          event.preventDefault();
          view.distance = Math.max(
            1_100,
            Math.min(55_000, view.distance * Math.exp(event.deltaY * 0.0008)),
          );
        };
        const onKeyDown = (event: KeyboardEvent) => keys.add(event.code);
        const onKeyUp = (event: KeyboardEvent) => keys.delete(event.code);
        const onGamepad = (event: GamepadEvent) => {
          statsRef.current.gamepad = event.gamepad.id
            .replace(/\s*\(.+\)\s*/, '')
            .slice(0, 32);
          onStats({ ...statsRef.current });
        };
        const onGamepadDisconnect = () => {
          statsRef.current.gamepad = null;
          onStats({ ...statsRef.current });
        };

        renderer.domElement.addEventListener('pointerdown', onPointerDown);
        renderer.domElement.addEventListener('pointermove', onPointerMove);
        renderer.domElement.addEventListener('pointerup', onPointerUp);
        renderer.domElement.addEventListener('pointercancel', onPointerUp);
        renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('gamepadconnected', onGamepad);
        window.addEventListener('gamepaddisconnected', onGamepadDisconnect);

        cleanupListeners.push(() => {
          renderer.domElement.removeEventListener('pointerdown', onPointerDown);
          renderer.domElement.removeEventListener('pointermove', onPointerMove);
          renderer.domElement.removeEventListener('pointerup', onPointerUp);
          renderer.domElement.removeEventListener('pointercancel', onPointerUp);
          renderer.domElement.removeEventListener('wheel', onWheel);
          window.removeEventListener('keydown', onKeyDown);
          window.removeEventListener('keyup', onKeyUp);
          window.removeEventListener('gamepadconnected', onGamepad);
          window.removeEventListener('gamepaddisconnected', onGamepadDisconnect);
        });

        const updateSize = () => {
          if (!mountRef.current) return;
          const width = mountRef.current.clientWidth;
          const height = mountRef.current.clientHeight;
          camera.aspect = width / Math.max(height, 1);
          camera.updateProjectionMatrix();
          renderer.setSize(width, height, false);
        };
        resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(mountRef.current);
        updateSize();

        let previous = performance.now();
        let reportAt = previous;
        let frameCount = 0;
        let lastGamepadName = statsRef.current.gamepad;

        const animate = (now: number) => {
          if (disposed) return;
          const delta = Math.min(0.05, (now - previous) / 1000);
          previous = now;
          frameCount += 1;

          const forward = new THREE.Vector3(
            -Math.sin(view.yaw),
            0,
            -Math.cos(view.yaw),
          );
          const right = new THREE.Vector3(-forward.z, 0, forward.x);
          const moveSpeed = view.distance * 0.32 * delta;
          if (keys.has('KeyW')) view.target.addScaledVector(forward, moveSpeed);
          if (keys.has('KeyS')) view.target.addScaledVector(forward, -moveSpeed);
          if (keys.has('KeyA')) view.target.addScaledVector(right, -moveSpeed);
          if (keys.has('KeyD')) view.target.addScaledVector(right, moveSpeed);
          if (keys.has('KeyQ')) view.target.y -= moveSpeed;
          if (keys.has('KeyE')) view.target.y += moveSpeed;

          const gamepad = navigator.getGamepads?.()[0];
          if (gamepad) {
            const leftX = refineAxis(gamepad.axes[0] ?? 0);
            const leftY = refineAxis(gamepad.axes[1] ?? 0);
            const rightX = refineAxis(gamepad.axes[2] ?? 0);
            const rightY = refineAxis(gamepad.axes[3] ?? 0);
            const turbo =
              gamepad.buttons[4]?.pressed || gamepad.buttons[5]?.pressed ? 3.5 : 1;
            const padSpeed = moveSpeed * turbo * 1.4;
            view.target.addScaledVector(right, leftX * padSpeed);
            view.target.addScaledVector(forward, -leftY * padSpeed);
            view.target.y +=
              ((gamepad.buttons[7]?.value ?? 0) -
                (gamepad.buttons[6]?.value ?? 0)) *
              padSpeed;
            view.yaw -= rightX * delta * 1.65;
            view.pitch = Math.max(
              0.08,
              Math.min(1.28, view.pitch - rightY * delta * 1.35),
            );
            const detectedName = gamepad.id
              .replace(/\s*\(.+\)\s*/, '')
              .slice(0, 32);
            if (detectedName !== lastGamepadName) {
              lastGamepadName = detectedName;
              statsRef.current.gamepad = detectedName;
            }
          }

          const horizontalDistance = Math.cos(view.pitch) * view.distance;
          camera.position.set(
            view.target.x + Math.sin(view.yaw) * horizontalDistance,
            view.target.y + Math.sin(view.pitch) * view.distance,
            view.target.z + Math.cos(view.yaw) * horizontalDistance,
          );
          camera.lookAt(view.target);
          marker.rotation.y = -view.yaw;

          renderer.render(scene, camera);

          if (now - reportAt >= 700) {
            statsRef.current.fps = Math.round(
              (frameCount * 1_000) / (now - reportAt),
            );
            statsRef.current.renderer = 'WEBGPU';
            onStats({ ...statsRef.current });
            reportAt = now;
            frameCount = 0;
          }

          frameHandle = requestAnimationFrame(animate);
        };

        statsRef.current.renderer = 'WEBGPU';
        onStats({ ...statsRef.current });
        setLoading('');
        frameHandle = requestAnimationFrame(animate);

        cleanupListeners.push(() => {
          scene.traverse((object) => {
            if (object instanceof THREE.Mesh) object.geometry.dispose();
          });
          material.dispose();
          renderer.dispose();
          renderer.domElement.remove();
        });
      } catch (error) {
        console.error(error);
        statsRef.current.renderer = 'UNAVAILABLE';
        onStats({ ...statsRef.current });
        setIssue(
          error instanceof Error
            ? error.message
            : '地形初始化失败，请刷新后重试。',
        );
      }
    }

    void initialize();

    return () => {
      disposed = true;
      cancelAnimationFrame(frameHandle);
      resizeObserver?.disconnect();
      cleanupListeners.forEach((cleanup) => cleanup());
      terrainRef.current = null;
      materialRef.current = null;
      resetRef.current = null;
    };
  }, [center.latitude, center.longitude, highDetail, onStats]);

  return (
    <div ref={mountRef} className="terrain-viewport">
      {loading && !issue ? (
        <output className="loading-screen">
          <div className="loading-radar"><span /></div>
          <p>{loading}</p>
          <span>解析吉隆口岸高程瓦片</span>
        </output>
      ) : null}
      {issue ? (
        <div className="unsupported-screen" role="alert">
          <MountainIcon />
          <p>WEBGPU UNAVAILABLE</p>
          <h2>无法启动地形引擎</h2>
          <span>{issue}</span>
        </div>
      ) : null}
    </div>
  );
}

function MountainIcon() {
  return (
    <svg viewBox="0 0 64 48" aria-hidden="true">
      <path d="M3 43 22 12l9 15L40 9l21 34H3Z" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="m16 22 6-10 6 10m4 6 8-19 8 20" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
