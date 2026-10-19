/**
 * Universal Tutor Project — cargador del rol UniversalTutor
 * ========================================================
 *
 * Carga el system prompt del tutor desde la carpeta `roles/` que vive JUNTO a
 * esta extensión (dentro del paquete), y lo inyecta en cada turno.
 *
 *   roles/Universal_Tutor_Project.md    ← el rol por defecto
 *
 * No depende de ninguna ruta personal: la carpeta se resuelve desde la propia
 * ubicación del archivo (funciona igual instalado por git, npm o ruta local).
 *
 * Frontmatter opcional al inicio del archivo de rol:
 *
 *   ---
 *   pensamiento: high              # off|minimal|low|medium|high|xhigh|max
 *   herramientas: read,write,edit  # lista separada por comas; vacía = sin herramientas
 *   modo: reemplazar               # reemplazar (default) | agregar
 *   ---
 *   Eres UniversalTutor…
 *
 * "reemplazar" sustituye por completo el system prompt de pi. "agregar" lo añade
 * al final conservando la identidad y las herramientas de pi.
 *
 * NO fija provider ni modelo: cada quien usa el modelo que tenga configurado.
 *
 * Arranque:
 *   - `/tutor`            activa el rol (o elige si hay varios)
 *   - `/tutor off`        lo quita y devuelve el system prompt normal de pi
 *   - `pi --tutor`        arrancar ya con el rol puesto
 *   - automático: si el directorio de trabajo contiene `tutor-*.md` o una carpeta
 *     `libro-…` (una sesión de curso ya iniciada), el rol se activa solo. En un curso
 *     NUEVO todavía no existen esos archivos: usa `pi --tutor` o `/tutor`.
 *
 * Convive con `libro-tutor.ts`: esa extensión declara su estado en el request al
 * proveedor (`before_provider_request`), así que no choca con la sustitución del
 * system prompt que hace esta extensión en `before_agent_start`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface Rol {
	nombre: string;
	pensamiento?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	herramientas?: string[];
	modo: "reemplazar" | "agregar";
	contenido: string;
}

const TUTOR_FILE_RE = /^tutor-.+\.md$/;
const BOOK_DIR_RE = /^libro-.+/;

/** Carpeta `roles/` del paquete (junto a este archivo), con override por variable. */
function rolesDir(): string {
	if (process.env.UTP_ROLES_DIR) return process.env.UTP_ROLES_DIR;
	const here = path.dirname(fileURLToPath(import.meta.url));
	const local = path.join(here, "..", "roles");
	if (existsSync(local)) return local;
	return path.join(here, "roles");
}

/** Rol explícito por archivo (override), si UTP_ROLE apunta a un .md. */
function roleOverride(): string | undefined {
	const p = process.env.UTP_ROLE;
	if (!p) return undefined;
	const abs = path.isAbsolute(p) ? p : path.join(rolesDir(), p);
	return existsSync(abs) ? abs : undefined;
}

function parseRol(nombre: string, raw: string): Rol {
	let front: Record<string, string> = {};
	let contenido = raw;
	const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (m) {
		for (const line of m[1].split(/\r?\n/)) {
			const idx = line.indexOf(":");
			if (idx > 0 && !line.trimStart().startsWith("#")) front[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
		}
		contenido = raw.slice(m[0].length);
	}
	return {
		nombre,
		pensamiento: front["pensamiento"] as Rol["pensamiento"] | undefined,
		herramientas: Object.prototype.hasOwnProperty.call(front, "herramientas")
			? front["herramientas"].split(",").map((s) => s.trim()).filter(Boolean)
			: undefined,
		modo: front["modo"] === "agregar" ? "agregar" : "reemplazar",
		contenido: contenido.trim(),
	};
}

function loadRoles(): Record<string, Rol> {
	const roles: Record<string, Rol> = {};
	const one = roleOverride();
	if (one) {
		const rol = parseRol(path.basename(one).replace(/\.(md|txt)$/i, ""), readFileSync(one, "utf-8"));
		roles[rol.nombre] = rol;
		return roles;
	}
	const dir = rolesDir();
	if (!existsSync(dir)) return roles;
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".md") || f.endsWith(".txt")).sort()) {
		const nombre = file.slice(0, file.lastIndexOf("."));
		roles[nombre] = parseRol(nombre, readFileSync(path.join(dir, file), "utf-8"));
	}
	return roles;
}

/** ¿El directorio de trabajo es una sesión de curso ya iniciada? */
function looksLikeCourseDir(cwd: string): boolean {
	let names: string[];
	try {
		names = readdirSync(cwd);
	} catch {
		return false;
	}
	return names.some((n) => TUTOR_FILE_RE.test(n) || BOOK_DIR_RE.test(n));
}

export default function (pi: ExtensionAPI) {
	let roles: Record<string, Rol> = {};
	let activo: Rol | undefined;

	function aplicarRol(rol: Rol, ctx: ExtensionContext): void {
		if (rol.pensamiento) pi.setThinkingLevel(rol.pensamiento);
		if (rol.herramientas !== undefined) pi.setActiveTools(rol.herramientas);
		activo = rol;
		ctx.ui.setStatus("tutor", ctx.ui.theme.fg("accent", `tutor: ${rol.nombre}`));
	}

	function despejarRol(ctx: ExtensionContext): void {
		activo = undefined;
		ctx.ui.setStatus("tutor", undefined);
	}

	pi.registerFlag("tutor", { description: "Arrancar la sesión con el rol UniversalTutor", type: "boolean" });

	pi.registerCommand("tutor", {
		description: "Activar o quitar el rol UniversalTutor",
		handler: async (args, ctx) => {
			roles = loadRoles();
			const nombres = Object.keys(roles);
			if (nombres.length === 0) {
				ctx.ui.notify(`Sin roles en ${rolesDir()}`, "warning");
				return;
			}
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "off" || arg === "ninguno") {
				despejarRol(ctx);
				ctx.ui.notify("Rol del tutor quitado (system prompt por defecto de pi)", "info");
				return;
			}
			let nombre: string | null;
			if (arg) {
				nombre = nombres.includes(arg) ? arg : nombres.find((n) => n.toLowerCase() === arg) ?? null;
			} else if (nombres.length === 1) {
				nombre = nombres[0];
			} else {
				nombre = await ctx.ui.select("Rol del tutor:", [...nombres, "(ninguno)"]);
			}
			if (nombre === null) return;
			if (nombre === "(ninguno)") {
				despejarRol(ctx);
				ctx.ui.notify("Rol del tutor quitado (system prompt por defecto de pi)", "info");
				return;
			}
			const rol = roles[nombre];
			if (!rol) {
				ctx.ui.notify(`Rol desconocido "${nombre}". Disponibles: ${nombres.join(", ")}`, "error");
				return;
			}
			aplicarRol(rol, ctx);
			ctx.ui.notify(`Rol "${rol.nombre}" activo`, "info");
		},
	});

	// Inyecta el prompt del rol en cada turno
	pi.on("before_agent_start", async (event) => {
		if (!activo) return;
		if (activo.modo === "agregar") {
			return { systemPrompt: `${event.systemPrompt}\n\n${activo.contenido}` };
		}
		return { systemPrompt: activo.contenido };
	});

	pi.on("session_start", async (_event, ctx) => {
		roles = loadRoles();

		// 1) Flag --tutor
		if (pi.getFlag("tutor") === true) {
			const rol = Object.values(roles)[0];
			if (rol) {
				aplicarRol(rol, ctx);
				ctx.ui.notify(`Rol "${rol.nombre}" activo`, "info");
			} else {
				ctx.ui.notify(`Sin roles en ${rolesDir()}`, "warning");
			}
			return;
		}

		// 2) Restaurar el rol persistido (tras /resume)
		const saved = ctx.sessionManager
			.getEntries()
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "utp-tutor")
			.pop() as { data?: { nombre: string } } | undefined;
		if (saved?.data?.nombre && roles[saved.data.nombre]) {
			aplicarRol(roles[saved.data.nombre], ctx);
			return;
		}

		// 3) Autodetección: carpeta de curso ya iniciada (tutor-*.md o libro-*/)
		if (looksLikeCourseDir(ctx.cwd)) {
			const rol = Object.values(roles)[0];
			if (rol) aplicarRol(rol, ctx);
		}
	});

	// Persistir el rol activo para que /resume lo recupere
	pi.on("turn_start", () => {
		if (activo) pi.appendEntry("utp-tutor", { nombre: activo.nombre });
	});
}
