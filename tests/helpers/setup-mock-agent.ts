// Safety net only. Node's built-in fetch is backed by its own bundled undici, which
// this dispatcher does not reach - tests route through GoogleAdsMock.fetchImpl
// instead. This still blocks anything that uses the npm undici client directly.
import { MockAgent, setGlobalDispatcher } from 'undici';

const agent = new MockAgent();
agent.disableNetConnect();
setGlobalDispatcher(agent);
