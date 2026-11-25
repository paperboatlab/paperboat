// Running a command from a key: the job, a toast while it works, the CLI's words when it is done.
import type {Client, Job} from '@paperboat/client/browser';
import type {Toast} from '@paperboatlab/ui';

export type Show = (t: Omit<Toast, 'id'> & {id?: number}) => number;
export type Act = (line: string, title: string, opts?: {quiet?: boolean}) => Promise<Job>;

export function makeAct(client: Client, show: Show): Act {
  return async (line, title, opts = {}) => {
    const id = opts.quiet ? undefined : show({title, detail: `paperboat ${line}`, state: 'working'});
    const job = await client.run(line, {text: true});
    const said = String(job.result ?? '').trim();
    if (job.state === 'failed') show({id, title: `${title}: failed`, detail: job.error, state: 'failed'});
    else if (!opts.quiet) show({id, title, detail: said || 'done', state: 'done'});
    return job;
  };
}
