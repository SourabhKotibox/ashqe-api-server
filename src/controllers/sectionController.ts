import type { FastifyRequest, FastifyReply } from 'fastify';
import { Types } from 'mongoose';
import { SectionModel } from '../models/Section';
import { MovieModel } from '../models/Movie';

const syncManualContent = async (section: any) => {
  const sectionIdStr = section._id.toString();

  // Remove this section from all movies
  await MovieModel.updateMany(
    { sections: sectionIdStr },
    { $pull: { sections: sectionIdStr } }
  );

  // Add this section to the new manual content IDs
  if (section.manualContentIds && section.manualContentIds.length > 0) {
    await MovieModel.updateMany(
      { _id: { $in: section.manualContentIds } },
      { $addToSet: { sections: sectionIdStr } }
    );
  }
};

export const getSections = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as {
      contentType?: 'movie';
      activeOnly?: string;
    };

    const filter: any = {};
    if (query.contentType) filter.contentType = query.contentType;
    if (query.activeOnly === 'true') filter.isActive = true;

    const sections = await SectionModel.find(filter).sort({ position: 1 });
    reply.send({ success: true, data: sections });
  } catch (error) {
    request.log.error(error);
    reply.status(500).send({ success: false, error: 'Failed to fetch sections' });
  }
};

export const getSectionById = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const params = request.params as { id: string };
    const section = await SectionModel.findById(params.id);
    if (!section) {
      reply.status(404).send({ success: false, error: 'Section not found' });
      return;
    }
    reply.send({ success: true, data: section });
  } catch (error) {
    request.log.error(error);
    reply.status(500).send({ success: false, error: 'Failed to fetch section' });
  }
};

export const createSection = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = request.body as any;

    // Normalize / sanitize payload from admin UI
    if (!body.key) body.key = `section-${Date.now()}`;
    if (!body.category) body.category = body.title || body.key;
    if (!body.contentType || body.contentType === 'mixed') {
      // web home builder sends mixed; store as mixed (allowed)
      body.contentType = body.contentType || 'movie';
    }
    if (Array.isArray(body.manualContentIds)) {
      body.manualContentIds = body.manualContentIds.filter((id: string) =>
        Types.ObjectId.isValid(id)
      );
    }

    const section = await SectionModel.create(body);
    await syncManualContent(section);
    reply.status(201).send({ success: true, data: section });
  } catch (error: any) {
    request.log.error(error);
    const message =
      error?.code === 11000
        ? 'A section with this key already exists'
        : error?.message || 'Failed to create section';
    reply.status(500).send({ success: false, error: message });
  }
};

export const updateSection = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const params = request.params as { id: string };
    const body = request.body as any;
    const section = await SectionModel.findByIdAndUpdate(params.id, body, { new: true });
    if (!section) {
      reply.status(404).send({ success: false, error: 'Section not found' });
      return;
    }
    await syncManualContent(section);
    reply.send({ success: true, data: section });
  } catch (error) {
    request.log.error(error);
    reply.status(500).send({ success: false, error: 'Failed to update section' });
  }
};

export const deleteSection = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const params = request.params as { id: string };
    const section = await SectionModel.findByIdAndDelete(params.id);
    if (!section) {
      reply.status(404).send({ success: false, error: 'Section not found' });
      return;
    }
    await MovieModel.updateMany(
      { sections: section._id.toString() },
      { $pull: { sections: section._id.toString() } }
    );
    reply.send({ success: true, message: 'Section deleted successfully' });
  } catch (error) {
    request.log.error(error);
    reply.status(500).send({ success: false, error: 'Failed to delete section' });
  }
};

export const reorderSections = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { updates } = request.body as { updates: { id: string, position: number }[] };
    
    const operations = updates.map(update => ({
      updateOne: {
        filter: { _id: update.id },
        update: { $set: { position: update.position } }
      }
    }));
    
    if (operations.length > 0) {
      await SectionModel.bulkWrite(operations);
    }
    
    reply.send({ success: true, message: 'Sections reordered successfully' });
  } catch (error) {
    request.log.error(error);
    reply.status(500).send({ success: false, error: 'Failed to reorder sections' });
  }
};
