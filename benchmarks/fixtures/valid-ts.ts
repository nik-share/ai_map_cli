interface Task {
  id: string;
  title: string;
}

function loggableClass(): ClassDecorator {
  return () => {
    return;
  };
}

function formatTask(task: Task): string {
  return `${task.id}: ${task.title}`;
}

@loggableClass()
class Planner {
  readonly tasks: Task[];

  constructor(tasks: Task[]) {
    this.tasks = tasks;
  }

  get labels(): string[] {
    return this.tasks.map((task) => formatTask(task));
  }
}

export const useTokenBudget = (max: number, multiplier = 2): number => {
  return max * multiplier;
};

const toString = (...values: Array<string | number>): string => {
  return values.join("-");
};

export const describeTask = (task: Task): string => {
  return toString(task.id, task.title);
};

export const tasks = [
  { id: "1", title: "benchmark" },
  { id: "2", title: "validate" },
];

export const planner = new Planner(tasks);
