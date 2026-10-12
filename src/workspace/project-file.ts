import { join } from "node:path";

export const projectDir = (workspace: string, project: string) => join(workspace, "projects", project);
export const projectFile = (workspace: string, project: string) => join(projectDir(workspace, project), "project.json");
