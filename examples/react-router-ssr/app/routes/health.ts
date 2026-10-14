// A resource route: no default export, so React Router answers with the loader's response.
export function loader() {
  return Response.json({ status: "ok" });
}
