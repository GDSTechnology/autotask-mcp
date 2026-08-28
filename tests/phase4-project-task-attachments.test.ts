// Project/task attachment listing (Phase 4 §5.7 read, #45). Mocked http.
jest.mock('autotask-node', () => ({ AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mock: no API')) } }));
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
function withHttp(fake: any) { const s = new AutotaskService(config, logger); jest.spyOn(s as any, 'ensureClient').mockResolvedValue(fake); return s; }
afterEach(() => jest.restoreAllMocks());
describe('project/task attachments (read)', () => {
  test('project attachments query Projects/Attachments child route', async () => {
    const childQuery = jest.fn().mockResolvedValue([{ id: 1 }]);
    const s = withHttp({ childQuery });
    await s.searchProjectAttachments(152);
    expect(childQuery).toHaveBeenCalledWith('Projects', 152, 'Attachments', expect.anything(), expect.anything());
  });
  test('task attachments query Tasks/Attachments child route', async () => {
    const childQuery = jest.fn().mockResolvedValue([]);
    const s = withHttp({ childQuery });
    await s.searchTaskAttachments(9);
    expect(childQuery).toHaveBeenCalledWith('Tasks', 9, 'Attachments', expect.anything(), expect.anything());
  });
});
