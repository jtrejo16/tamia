/**
 * Menus de arranque para los giros de restaurante: un menu de EJEMPLO realista (con modificadores) que se carga al dar de alta
 * el negocio, para que el dueno (o un prospecto en una demo) vea el asistente funcionando desde el primer minuto y solo
 * ajuste platillos y precios. Los precios van en pesos y son de referencia: el dueno debe revisarlos.
 *
 * Datos puros, sin codigo de servidor: los aplica packages/inbox/src/starter.ts.
 */

export interface StarterOption {
  name: string;
  /** Lo que suma al precio del platillo, en pesos. */
  extra?: number;
}

export interface StarterGroup {
  /** Clave para pegarlo a los platillos. */
  key: string;
  name: string;
  required?: boolean;
  multiple?: boolean;
  maxChoices?: number;
  options: StarterOption[];
}

export interface StarterItem {
  name: string;
  description?: string;
  /** Pesos. */
  price: number;
  groups?: string[];
}

export interface StarterMenu {
  id: string;
  title: string;
  groups: StarterGroup[];
  categories: Array<{ name: string; items: StarterItem[] }>;
}

const TAQUERIA: StarterMenu = {
  id: "taqueria",
  title: "Taquería",
  groups: [
    { key: "tortilla", name: "Tortilla", options: [{ name: "Maíz" }, { name: "Harina", extra: 3 }] },
    { key: "extras", name: "Extras", multiple: true, maxChoices: 3, options: [{ name: "Queso", extra: 12 }, { name: "Guacamole", extra: 15 }, { name: "Piña", extra: 8 }, { name: "Cebolla asada", extra: 5 }] },
    { key: "tamano-bebida", name: "Tamaño de la bebida", required: true, options: [{ name: "Chico" }, { name: "Grande", extra: 12 }] },
  ],
  categories: [
    {
      name: "Tacos",
      items: [
        { name: "Taco al pastor", description: "Cerdo adobado con piña, cebolla y cilantro", price: 22, groups: ["tortilla", "extras"] },
        { name: "Taco de bistec", description: "Res a la plancha con cebolla y cilantro", price: 28, groups: ["tortilla", "extras"] },
        { name: "Taco de suadero", description: "Suadero de res dorado con cebolla y cilantro", price: 26, groups: ["tortilla", "extras"] },
        { name: "Taco de longaniza", description: "Longaniza con cebolla y cilantro", price: 24, groups: ["tortilla", "extras"] },
        { name: "Taco de cochinita", description: "Cochinita pibil con cebolla morada", price: 24, groups: ["tortilla", "extras"] },
        { name: "Campechano", description: "Mezcla de bistec y chorizo", price: 30, groups: ["tortilla", "extras"] },
      ],
    },
    {
      name: "Especialidades",
      items: [
        { name: "Gringa de pastor", description: "Tortilla de harina con queso y carne al pastor", price: 55 },
        { name: "Alambre de res", description: "Res, tocino, pimiento, cebolla y queso, con tortillas", price: 110 },
        { name: "Orden de tacos de pastor (5 piezas)", description: "Cinco tacos al pastor", price: 100, groups: ["tortilla"] },
        { name: "Queso fundido con chorizo", description: "Con tortillas de harina", price: 85 },
      ],
    },
    {
      name: "Bebidas",
      items: [
        { name: "Agua de horchata", price: 25, groups: ["tamano-bebida"] },
        { name: "Agua de jamaica", price: 25, groups: ["tamano-bebida"] },
        { name: "Refresco", description: "Cola, naranja o toronja", price: 22 },
        { name: "Agua embotellada", price: 15 },
      ],
    },
  ],
};

const PIZZERIA: StarterMenu = {
  id: "pizzeria",
  title: "Pizzería",
  groups: [
    { key: "tamano", name: "Tamaño", required: true, options: [{ name: "Chica" }, { name: "Mediana", extra: 40 }, { name: "Grande", extra: 80 }, { name: "Familiar", extra: 130 }] },
    { key: "orilla", name: "Orilla", options: [{ name: "Normal" }, { name: "Rellena de queso", extra: 35 }] },
    { key: "extras", name: "Extras", multiple: true, maxChoices: 4, options: [{ name: "Queso extra", extra: 25 }, { name: "Pepperoni extra", extra: 30 }, { name: "Champiñones", extra: 20 }, { name: "Jalapeños", extra: 15 }, { name: "Piña", extra: 15 }] },
    { key: "tamano-bebida", name: "Tamaño de la bebida", required: true, options: [{ name: "600 ml" }, { name: "2 litros", extra: 25 }] },
  ],
  categories: [
    {
      name: "Pizzas",
      items: [
        { name: "Pepperoni", description: "Salsa de tomate, queso mozzarella y pepperoni", price: 119, groups: ["tamano", "orilla", "extras"] },
        { name: "Hawaiana", description: "Jamón, piña y queso mozzarella", price: 119, groups: ["tamano", "orilla", "extras"] },
        { name: "Mexicana", description: "Chorizo, jalapeño, cebolla y frijoles", price: 129, groups: ["tamano", "orilla", "extras"] },
        { name: "Cuatro quesos", description: "Mozzarella, manchego, parmesano y queso crema", price: 139, groups: ["tamano", "orilla", "extras"] },
        { name: "Vegetariana", description: "Champiñones, pimiento, cebolla, aceituna y jitomate", price: 125, groups: ["tamano", "orilla", "extras"] },
      ],
    },
    {
      name: "Complementos",
      items: [
        { name: "Pan de ajo", description: "Con queso gratinado", price: 65 },
        { name: "Alitas (10 piezas)", description: "BBQ, búfalo o naturales", price: 135 },
        { name: "Ensalada de la casa", price: 70 },
      ],
    },
    {
      name: "Bebidas",
      items: [
        { name: "Refresco", description: "Cola, naranja o toronja", price: 28, groups: ["tamano-bebida"] },
        { name: "Agua de sabor", price: 25, groups: ["tamano-bebida"] },
        { name: "Cerveza", price: 40 },
      ],
    },
    { name: "Postres", items: [{ name: "Cheesecake", price: 65 }, { name: "Brownie con helado", price: 70 }] },
  ],
};

const RESTAURANTE: StarterMenu = {
  id: "restaurante",
  title: "Restaurante o fonda",
  groups: [
    { key: "guarnicion", name: "Guarnición", options: [{ name: "Arroz" }, { name: "Frijoles" }, { name: "Ensalada" }, { name: "Papas fritas", extra: 10 }] },
    { key: "tamano-bebida", name: "Tamaño de la bebida", required: true, options: [{ name: "Chico" }, { name: "Grande", extra: 12 }] },
  ],
  categories: [
    {
      name: "Entradas",
      items: [
        { name: "Sopa del día", price: 55 },
        { name: "Ensalada de la casa", price: 65 },
        { name: "Queso fundido", description: "Con tortillas", price: 85 },
      ],
    },
    {
      name: "Platos fuertes",
      items: [
        { name: "Pollo a la plancha", description: "Pechuga con guarnición a elegir", price: 135, groups: ["guarnicion"] },
        { name: "Milanesa de res", description: "Empanizada, con guarnición a elegir", price: 150, groups: ["guarnicion"] },
        { name: "Enchiladas verdes", description: "Con pollo, crema y queso", price: 120 },
        { name: "Hamburguesa de la casa", description: "Con papas", price: 130 },
      ],
    },
    {
      name: "Bebidas",
      items: [
        { name: "Agua de sabor", price: 28, groups: ["tamano-bebida"] },
        { name: "Refresco", price: 25 },
        { name: "Café", price: 30 },
      ],
    },
    { name: "Postres", items: [{ name: "Flan", price: 55 }, { name: "Pastel del día", price: 65 }] },
  ],
};

export const STARTER_MENUS: Readonly<Record<string, StarterMenu>> = { taqueria: TAQUERIA, pizzeria: PIZZERIA, restaurante: RESTAURANTE };

/** El menu de arranque de un giro, o null si ese giro no tiene. */
export const starterMenuFor = (vertical: string | null | undefined): StarterMenu | null => (vertical ? (STARTER_MENUS[vertical] ?? null) : null);
